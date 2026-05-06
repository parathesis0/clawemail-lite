import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = { authUrl: "", homeEmail: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--auth-url" || item === "--url") {
      parsed.authUrl = argv[index + 1] || "";
      index += 1;
    } else if (item === "--home-email") {
      parsed.homeEmail = argv[index + 1] || "";
      index += 1;
    } else if (!parsed.authUrl) {
      parsed.authUrl = item;
    }
  }
  return parsed;
}

function normalizeAuthUrl(value) {
  const url = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://u.163.com/${url}`;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const resolved = resolveCommand(command);
    const child = spawn(resolved.file, [...resolved.prefixArgs, ...args], {
      shell: resolved.shell,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";

    if (options.capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

function resolveCommand(command) {
  if (command === "mail-cli" && process.env.MAIL_CLI_BIN) {
    return { file: process.env.MAIL_CLI_BIN, prefixArgs: [], shell: false };
  }
  if (process.platform !== "win32") return { file: command, prefixArgs: [], shell: false };
  if (command === "mail-cli") {
    if (process.env.npm_config_prefix) {
      return {
        file: process.execPath,
        prefixArgs: [`${process.env.npm_config_prefix}\\node_modules\\@clawemail\\mail-cli\\bin\\mail-cli`],
        shell: false,
      };
    }
    return {
      file: process.execPath,
      prefixArgs: [`${process.env.APPDATA}\\npm\\node_modules\\@clawemail\\mail-cli\\bin\\mail-cli`],
      shell: false,
    };
  }
  return { file: command, prefixArgs: [], shell: true };
}

function parseLine(line) {
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  if (first < 0 || second < 0) return null;
  return {
    name: line.slice(0, first),
    accountId: line.slice(first + 1, second),
    credential: line.slice(second + 1),
  };
}

async function ensureMailCli() {
  try {
    await run("mail-cli", ["--version"], { capture: true });
    return;
  } catch {
    console.log("mail-cli not found, installing @clawemail/mail-cli globally...");
    await run("npm", ["i", "@clawemail/mail-cli", "-g", "--force"]);
  }
}

async function fetchAuth(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Auth URL failed with HTTP ${response.status}. The link may be expired or already used.`);
  }
  const body = (await response.text()).trim();
  if (!body || /<html|<!doctype/i.test(body)) {
    throw new Error("Auth URL returned an invalid response. The link may be expired or already used.");
  }
  return body;
}

async function main() {
  const authUrl = normalizeAuthUrl(args.authUrl);
  if (!authUrl) {
    console.error("Usage: npm run setup -- --auth-url <auth-url> [--home-email <email>]");
    console.error('Example: npm run setup -- --auth-url "t1/xxxx" --home-email "you@example.com"');
    process.exit(1);
  }

  await ensureMailCli();
  if (args.homeEmail) console.log(`Home email: ${args.homeEmail}`);

  console.log("Fetching ClawEmail account info...");
  const body = await fetchAuth(authUrl);
  const accounts = [];
  let apiKey = "";

  for (const raw of body.split(/\r?\n/)) {
    const parsed = parseLine(raw.trim());
    if (!parsed) continue;
    if (parsed.name === "__apikey__") {
      apiKey = parsed.credential;
    } else {
      accounts.push({
        ...parsed,
        email: `${parsed.name}@claw.163.com`,
      });
    }
  }

  if (apiKey) {
    console.log("Configuring mail-cli API key...");
    await run("mail-cli", ["auth", "apikey", "set", apiKey], { capture: true });
  }

  for (const account of accounts) {
    const cliArgs = [];
    if (account.accountId !== "default") cliArgs.push("--profile", account.accountId);
    cliArgs.push("auth", "login", "--user", account.email);
    if (account.credential) cliArgs.push("--auth-method", "password", "--password", account.credential);

    console.log(`Registering ${account.email} (${account.accountId})...`);
    await run("mail-cli", cliArgs, { capture: true });
  }

  console.log("");
  console.log("Setup complete.");
  for (const account of accounts) {
    console.log(`- ${account.accountId}: ${account.email}`);
  }
  console.log("");
  console.log("Run: npm start");
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
