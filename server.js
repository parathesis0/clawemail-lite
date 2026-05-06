import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const root = resolve(".");
const publicDir = join(root, "public");
const requestedPort = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

function send(res, status, value, headers = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  res.writeHead(status, {
    "content-type": typeof value === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("Request body is too large"));
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cli(args, { parseJson = true, profile = "" } = {}) {
  const profileArgs = profile && profile !== "default" ? ["--profile", profile] : [];
  const fullArgs = parseJson ? ["--json", ...profileArgs, ...args] : [...profileArgs, ...args];
  return new Promise((resolveCli, reject) => {
    const command = mailCliCommand();
    const child = spawn(command.file, [...command.prefixArgs, ...fullArgs]);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `mail-cli exited with ${code}`).trim()));
        return;
      }
      if (!parseJson) {
        resolveCli(stdout.trim());
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolveCli({ success: true, data: null });
        return;
      }
      try {
        resolveCli(JSON.parse(text));
      } catch {
        resolveCli({ success: true, data: text });
      }
    });
  });
}

function mailCliCommand() {
  if (process.env.MAIL_CLI_BIN) return { file: process.env.MAIL_CLI_BIN, prefixArgs: [] };
  if (process.platform !== "win32") return { file: "mail-cli", prefixArgs: [] };
  if (process.env.npm_config_prefix) {
    return {
      file: process.execPath,
      prefixArgs: [join(process.env.npm_config_prefix, "node_modules", "@clawemail", "mail-cli", "bin", "mail-cli")],
    };
  }
  return {
    file: process.execPath,
    prefixArgs: [join(process.env.APPDATA || "", "npm", "node_modules", "@clawemail", "mail-cli", "bin", "mail-cli")],
  };
}

function requestProfile(url) {
  return String(url.searchParams.get("profile") || "").trim();
}

function addOpt(args, flag, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") args.push(flag, String(value));
}

async function withBodyFile(body, fn) {
  const path = join(tmpdir(), `clawmail-lite-${randomUUID()}.txt`);
  await fs.writeFile(path, body || "", "utf8");
  try {
    return await fn(path);
  } finally {
    await fs.rm(path, { force: true });
  }
}

async function api(req, res, url) {
  const profile = requestProfile(url);

  if (req.method === "GET" && url.pathname === "/api/status") {
    const [profiles, auth] = await Promise.all([
      cli(["auth", "list"]),
      cli(["auth", "test"], { parseJson: false, profile }).then((message) => ({ ok: true, message })).catch((error) => ({ ok: false, message: error.message })),
    ]);
    send(res, 200, { profiles, auth });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/folders") {
    send(res, 200, await cli(["folder", "list"], { profile }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-mailboxes") {
    send(res, 200, await cli(["clawemail", "list"], { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-mailboxes") {
    const body = await readJson(req);
    if (!body.prefix) throw new Error("prefix is required");
    const args = ["clawemail", "create", "--prefix", body.prefix, "--type", body.type || "sub", "--no-install-info"];
    addOpt(args, "--display-name", body.displayName);
    send(res, 200, await cli(args, { profile }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-mailbox") {
    const uid = url.searchParams.get("uid");
    if (!uid) throw new Error("uid is required");
    send(res, 200, await cli(["clawemail", "info", "--uid", uid], { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-mailbox/delete") {
    const body = await readJson(req);
    if (!body.uid) throw new Error("uid is required");
    send(res, 200, await cli(["clawemail", "delete", "--uid", body.uid], { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-mailbox/enable") {
    const body = await readJson(req);
    if (!body.uid) throw new Error("uid is required");
    send(res, 200, await cli(["clawemail", "enable", "--uid", body.uid], { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-mailbox/disable") {
    const body = await readJson(req);
    if (!body.uid) throw new Error("uid is required");
    send(res, 200, await cli(["clawemail", "disable", "--uid", body.uid], { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-mailbox/profile") {
    const body = await readJson(req);
    if (!body.uid) throw new Error("uid is required");
    const args = ["clawemail", "profile", "--uid", body.uid];
    addOpt(args, "--display-name", body.displayName);
    send(res, 200, await cli(args, { profile }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/messages") {
    const fid = url.searchParams.get("fid") || "1";
    const keyword = url.searchParams.get("q") || "";
    const args = keyword ? ["mail", "search", "--fid", fid, "--keyword", keyword] : ["mail", "list", "--fid", fid];
    addOpt(args, "--limit", url.searchParams.get("limit") || "30");
    addOpt(args, "--start", url.searchParams.get("start"));
    if (url.searchParams.get("unread") === "1") args.push("--unread");
    if (!keyword) args.push("--desc");
    send(res, 200, await cli(args, { profile }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/message") {
    const fid = url.searchParams.get("fid") || "1";
    const id = url.searchParams.get("id");
    if (!id) throw new Error("Missing message id");
    const [header, body, structure] = await Promise.all([
      cli(["read", "header", "--fid", fid, "--id", id], { profile }),
      cli(["read", "body", "--fid", fid, "--id", id], { parseJson: false, profile }),
      cli(["read", "structure", "--fid", fid, "--id", id], { profile }).catch(() => ({ success: false, data: null })),
    ]);
    send(res, 200, { header, body, structure });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    const body = await readJson(req);
    if (!body.to || !body.subject) throw new Error("收件人和主题不能为空");
    const result = await withBodyFile(body.body, (file) => {
      const args = ["compose", "send", "--to", body.to, "--subject", body.subject, "--body-file", file];
      addOpt(args, "--cc", body.cc);
      addOpt(args, "--bcc", body.bcc);
      addOpt(args, "--from", body.from);
      if (body.html) args.push("--html");
      for (const path of body.attachments || []) args.push("--attach", path);
      return cli(args, { profile });
    });
    send(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reply") {
    const body = await readJson(req);
    if (!body.id) throw new Error("Missing message id");
    const result = await withBodyFile(body.body, (file) => {
      const args = ["compose", "reply", "--fid", body.fid || "1", "--id", body.id, "--body-file", file];
      addOpt(args, "--cc", body.cc);
      addOpt(args, "--override-to", body.overrideTo);
      if (body.all) args.push("--all");
      if (body.html) args.push("--html");
      for (const path of body.attachments || []) args.push("--attach", path);
      return cli(args, { profile });
    });
    send(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mark") {
    const body = await readJson(req);
    const args = ["mail", "mark", "--fid", body.fid || "1", "--ids", Array.isArray(body.ids) ? body.ids.join(",") : String(body.ids || "")];
    args.push(body.unread ? "--unread" : "--read");
    send(res, 200, await cli(args, { profile }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const body = await readJson(req);
    const args = ["mail", "move", "--fid", body.fid || "1", "--to-fid", body.toFid, "--ids", Array.isArray(body.ids) ? body.ids.join(",") : String(body.ids || "")];
    send(res, 200, await cli(args, { profile }));
    return;
  }

  send(res, 404, { error: "Unknown API endpoint" });
}

async function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = normalize(join(publicDir, requested));
  if (!file.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    send(res, 404, "Not found");
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, "Not found");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ico": "image/x-icon",
  };
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file)
    .on("error", () => {
      if (!res.headersSent) send(res, 500, "Failed to read file");
      else res.destroy();
    })
    .pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || String(error) });
  }
});

function listen(port, attempts = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set PORT to another value or stop the existing server.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`ClawMail Lite is running at http://${host}:${port}`);
  });
}

listen(requestedPort);
