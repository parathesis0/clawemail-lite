import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, randomBytes, pbkdf2Sync } from "node:crypto";

const passphrase = process.env.MIGRATE_PASSPHRASE || "";
const outFile = argValue("--out") || "clawmail-lite-migration.clawmail-backup";

if (!passphrase) {
  console.error("Set MIGRATE_PASSPHRASE before exporting.");
  console.error('Example: $env:MIGRATE_PASSPHRASE="long random phrase"; npm run migrate:export -- --out backup.clawmail-backup');
  process.exit(1);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function mailCliCommand() {
  if (process.platform !== "win32") return { file: "mail-cli", prefixArgs: [] };
  return {
    file: process.execPath,
    prefixArgs: [join(process.env.APPDATA || "", "npm", "node_modules", "@clawemail", "mail-cli", "bin", "mail-cli")],
  };
}

function runMailCli(args) {
  return new Promise((resolve, reject) => {
    const command = mailCliCommand();
    const child = spawn(command.file, [...command.prefixArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `mail-cli exited with ${code}`));
      else resolve(stdout.trim());
    });
  });
}

async function readIfExists(path, kind) {
  try {
    const data = await fs.readFile(path);
    return { kind, data: data.toString("base64") };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const config = JSON.parse(await runMailCli(["--json", "debug:config"]));
  const configPath = config.configPath;
  const configDir = dirname(configPath);
  const secretPath = join(homedir(), ".config", "mail-cli", "secrets.enc");
  const tokensDir = join(configDir, "tokens");

  const files = [];
  const configFile = await readIfExists(configPath, "config");
  const secretFile = await readIfExists(secretPath, "secret");
  if (configFile) files.push(configFile);
  if (secretFile) files.push(secretFile);

  try {
    const tokenFiles = await fs.readdir(tokensDir);
    for (const name of tokenFiles) {
      if (!name.endsWith(".json")) continue;
      const token = await readIfExists(join(tokensDir, name), `token:${name}`);
      if (token) files.push(token);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!files.length) throw new Error("No mail-cli state files found.");

  const plaintext = Buffer.from(JSON.stringify({
    app: "clawmail-lite",
    version: 1,
    createdAt: new Date().toISOString(),
    sourceProfile: config.profileName,
    sourceUser: config.profile?.user || "",
    files,
  }));

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 210_000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  await fs.writeFile(outFile, JSON.stringify({
    app: "clawmail-lite",
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations: 210_000,
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  }, null, 2));

  console.log(`Exported encrypted migration bundle: ${outFile}`);
  console.log(`Included ${files.length} mail-cli state file(s).`);
}

main().catch((error) => {
  console.error(`Export failed: ${error.message}`);
  process.exit(1);
});
