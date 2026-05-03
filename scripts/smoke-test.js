import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const externalTo = process.env.TEST_TO || "";
const port = Number(process.env.TEST_PORT || 9876);
const baseUrl = `http://localhost:${port}`;
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const runWord = runId.replace(/\d/g, (digit) => "abcdefghij"[Number(digit)]).slice(0, 12);
const qqSubject = `ClawMail Lite QQ test ${runId}`;
const selfSubject = `ClawMail Lite self test ${runId}`;
const checks = [];

let server;
let createdAgentSubUid = "";

function pass(name, detail = "") {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

function fail(name, error) {
  checks.push({ name, ok: false, detail: error.message || String(error) });
  console.error(`FAIL ${name} - ${error.message || error}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
    return detail;
  } catch (error) {
    fail(name, error);
    throw error;
  }
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { data: text };
  }
  if (!response.ok) throw new Error(data.error || text || `HTTP ${response.status}`);
  return data;
}

function unwrap(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}

function messageId(message) {
  return message.id || message.uid || message.messageId || message.mailId || "";
}

function messageSubject(message) {
  return message.subject || message.title || "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("Server did not start in time"));
    }, 10_000);

    server.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (!settled && text.includes(`http://localhost:${port}`)) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.on("error", reject);
    server.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Server exited before ready with code ${code}`));
      }
    });
  });
}

async function findMessage(fid, subject) {
  const payload = await request(`/api/messages?fid=${encodeURIComponent(fid)}&q=${encodeURIComponent(subject)}&limit=20`);
  const messages = unwrap(payload) || [];
  return messages.find((message) => messageSubject(message).includes(subject)) || messages[0] || null;
}

async function waitForMessage(fid, subject) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const message = await findMessage(fid, subject);
    if (message && messageId(message)) return message;
    await sleep(5_000);
  }
  throw new Error(`Timed out waiting for "${subject}" in folder ${fid}`);
}

async function main() {
  if (!externalTo) {
    throw new Error("Set TEST_TO to a real mailbox before running smoke tests.");
  }

  await startServer();

  const status = await step("auth status", async () => {
    const payload = await request("/api/status");
    if (!payload.auth?.ok) throw new Error(payload.auth?.message || "auth test failed");
    return payload.auth.message;
  });

  const folders = await step("folder list", async () => {
    const payload = await request("/api/folders");
    const data = unwrap(payload) || [];
    if (!data.length) throw new Error("no folders returned");
    return data;
  });

  const inbox = folders.find((item) => item.name === "收件箱") || folders.find((item) => item.id === "1") || folders[0];
  const sent = folders.find((item) => item.name === "已发送") || folders.find((item) => item.id === "3");
  const deleted = folders.find((item) => item.name === "已删除") || folders.find((item) => item.id === "4");

  const mailboxRoot = await step("agent mailbox list", async () => {
    const payload = await request("/api/agent-mailboxes");
    const root = unwrap(payload)?.mailbox;
    if (!root?.prefix || !root?.email) throw new Error("primary Agent mailbox missing");
    return root;
  });

  const subPrefix = `smoke${runWord.slice(0, 4)}`;

  await step("agent sub mailbox create", async () => {
    const payload = await request("/api/agent-mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: subPrefix, type: "sub", displayName: `smoke-${runId}` }),
    });
    const data = unwrap(payload)?.mailbox || unwrap(payload) || {};
    createdAgentSubUid = data.uid || data.email || `${subPrefix}@claw.163.com`;
    if (!createdAgentSubUid.endsWith("@claw.163.com")) throw new Error("created sub mailbox uid missing");
    return createdAgentSubUid;
  });

  await step("agent sub mailbox info", async () => {
    const payload = await request(`/api/agent-mailbox?uid=${encodeURIComponent(createdAgentSubUid)}`);
    const data = unwrap(payload)?.mailbox || unwrap(payload);
    if (!JSON.stringify(data).includes(createdAgentSubUid)) throw new Error("created sub mailbox not found");
    return createdAgentSubUid;
  });

  await step("agent sub mailbox rename", async () => {
    await request("/api/agent-mailbox/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: createdAgentSubUid, displayName: `renamed-${runId}` }),
    });
    return createdAgentSubUid;
  });

  await step("agent sub mailbox disable", async () => {
    await request("/api/agent-mailbox/disable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: createdAgentSubUid }),
    });
    return createdAgentSubUid;
  });

  await step("agent sub mailbox enable", async () => {
    await request("/api/agent-mailbox/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: createdAgentSubUid }),
    });
    return createdAgentSubUid;
  });

  await step("message list", async () => {
    const payload = await request(`/api/messages?fid=${encodeURIComponent(inbox.id)}&limit=5`);
    const data = unwrap(payload);
    if (!Array.isArray(data)) throw new Error("message list is not an array");
    return `${data.length} messages`;
  });

  const config = await step("debug config", async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    if (!response.ok) throw new Error("server status unavailable");
    return status;
  });

  const selfAddress = await step("current sender", async () => {
    const command = mailCliCommand();
    const child = spawn(command.file, [...command.prefixArgs, "--json", "debug:config"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(stderr || "debug:config failed");
    const data = JSON.parse(stdout);
    if (!data.profile?.user) throw new Error("profile user missing");
    return data.profile.user;
  });

  const attachmentPath = join(tmpdir(), `clawmail-lite-${runId}.txt`);
  await fs.writeFile(attachmentPath, `ClawMail Lite smoke test ${runId}\n`, "utf8");

  await step("send to QQ with attachment", async () => {
    await request("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: externalTo,
        subject: qqSubject,
        body: `This is a ClawMail Lite smoke test.\nRun: ${runId}\nSender: ${selfAddress}\n`,
        attachments: [attachmentPath],
      }),
    });
    return `${externalTo} / ${qqSubject}`;
  });

  await step("send to self", async () => {
    await request("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: selfAddress,
        subject: selfSubject,
        body: `Self receive/read/reply test for ${runId}`,
      }),
    });
    return `${selfAddress} / ${selfSubject}`;
  });

  const received = await step("receive and search self mail", async () => {
    const message = await waitForMessage(inbox.id, selfSubject);
    return message;
  });

  const receivedId = messageId(received);

  await step("read message", async () => {
    const payload = await request(`/api/message?fid=${encodeURIComponent(inbox.id)}&id=${encodeURIComponent(receivedId)}`);
    if (!String(payload.body || "").includes(runId)) throw new Error("message body did not contain run id");
    return receivedId;
  });

  await step("mark unread", async () => {
    await request("/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fid: inbox.id, ids: [receivedId], unread: true }),
    });
    return receivedId;
  });

  await step("mark read", async () => {
    await request("/api/mark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fid: inbox.id, ids: [receivedId], unread: false }),
    });
    return receivedId;
  });

  await step("reply to self mail", async () => {
    await request("/api/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fid: inbox.id, id: receivedId, overrideTo: selfAddress, body: `Reply smoke test ${runId}` }),
    });
    return receivedId;
  });

  if (sent) {
    await step("search sent mail", async () => {
      const message = await findMessage(sent.id, qqSubject);
      if (!message) throw new Error("QQ test mail not found in sent folder yet");
      return sent.id;
    });
  }

  if (deleted) {
    await step("move self mail to deleted", async () => {
      await request("/api/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fid: inbox.id, ids: [receivedId], toFid: deleted.id }),
      });
      return `${inbox.id} -> ${deleted.id}`;
    });
  }

  if (createdAgentSubUid) {
    await step("agent sub mailbox delete", async () => {
      await request("/api/agent-mailbox/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: createdAgentSubUid }),
      });
      return createdAgentSubUid;
    });
    createdAgentSubUid = "";
  }

  await fs.rm(attachmentPath, { force: true });
  const passed = checks.filter((item) => item.ok).length;
  console.log("");
  console.log(`Smoke test complete: ${passed}/${checks.length} checks passed.`);
  console.log(`QQ test subject: ${qqSubject}`);
  console.log(`Self test subject: ${selfSubject}`);
  console.log(`Debug config: ${config}`);
}

function mailCliCommand() {
  if (process.platform !== "win32") return { file: "mail-cli", prefixArgs: [] };
  return {
    file: process.execPath,
    prefixArgs: [`${process.env.APPDATA}\\npm\\node_modules\\@clawemail\\mail-cli\\bin\\mail-cli`],
  };
}

main()
  .catch((error) => {
    console.error("");
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (createdAgentSubUid) {
      try {
        await request("/api/agent-mailbox/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uid: createdAgentSubUid }),
        });
        console.log(`Cleaned up sub mailbox: ${createdAgentSubUid}`);
      } catch (error) {
        console.error(`Cleanup failed for ${createdAgentSubUid}: ${error.message}`);
      }
    }
    if (server && !server.killed) server.kill();
  });
