import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

const passphrase = process.env.MIGRATE_PASSPHRASE || "";
const inFile = argValue("--in") || "clawmail-lite-migration.clawmail-backup";
const force = process.argv.includes("--force");

if (!passphrase) {
  console.error("Set MIGRATE_PASSPHRASE before importing.");
  console.error('Example: $env:MIGRATE_PASSPHRASE="long random phrase"; npm run migrate:import -- --in backup.clawmail-backup --force');
  process.exit(1);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function targetPaths() {
  const configDir = process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "mail-cli")
    : join(homedir(), ".config", "mail-cli");
  return {
    config: join(configDir, "config.json"),
    secret: join(homedir(), ".config", "mail-cli", "secrets.enc"),
    tokenDir: join(configDir, "tokens"),
  };
}

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeStateFile(paths, file) {
  let target = "";
  if (file.kind === "config") target = paths.config;
  else if (file.kind === "secret") target = paths.secret;
  else if (file.kind.startsWith("token:")) target = join(paths.tokenDir, file.kind.slice("token:".length));
  else return;

  if (!force && await exists(target)) {
    throw new Error(`${target} already exists. Re-run with --force to overwrite.`);
  }
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(file.data, "base64"));
}

async function main() {
  const bundle = JSON.parse(await fs.readFile(inFile, "utf8"));
  if (bundle.app !== "clawmail-lite" || bundle.version !== 1) {
    throw new Error("Unsupported migration bundle.");
  }

  const key = pbkdf2Sync(passphrase, Buffer.from(bundle.salt, "base64"), bundle.iterations, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(bundle.iv, "base64"));
  decipher.setAuthTag(Buffer.from(bundle.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(bundle.data, "base64")),
    decipher.final(),
  ]);

  const payload = JSON.parse(plaintext.toString("utf8"));
  const paths = targetPaths();
  for (const file of payload.files || []) {
    await writeStateFile(paths, file);
  }

  console.log(`Imported ${payload.files?.length || 0} mail-cli state file(s).`);
  console.log("Run: mail-cli auth test");
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
});
