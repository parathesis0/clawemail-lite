const state = {
  fid: "1",
  folders: [],
  selected: null,
  replyMode: false,
};

const $ = (id) => document.getElementById(id);

async function request(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

function unwrap(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function messageId(msg) {
  return msg.id || msg.uid || msg.messageId || msg.mailId || "";
}

function messageSubject(msg) {
  return msg.subject || msg.title || "(无主题)";
}

function messageFrom(msg) {
  return formatAddress(msg.from || msg.sender || msg.fromName || "");
}

function messageDate(msg) {
  return msg.date || msg.time || msg.sentDate || msg.receivedDate || "";
}

async function loadStatus() {
  const status = await request("/api/status");
  const profiles = unwrap(status.profiles) || status.profiles || [];
  const profile = Array.isArray(profiles) ? profiles.find((item) => item.default) || profiles[0] : null;
  $("account").textContent = profile ? `${profile.profile} · ${profile.status}` : status.auth?.message || "已连接";
}

async function loadFolders() {
  const payload = await request("/api/folders");
  state.folders = unwrap(payload) || [];
  $("folders").innerHTML = "";
  $("moveTarget").innerHTML = "";

  for (const folder of state.folders) {
    const btn = document.createElement("button");
    btn.className = `folder${folder.id === state.fid ? " active" : ""}`;
    btn.innerHTML = `<span>${folder.name || folder.id}</span><small>${folder.unreadCount || 0}</small>`;
    btn.onclick = () => {
      state.fid = folder.id;
      state.selected = null;
      loadFolders();
      loadMessages();
    };
    $("folders").appendChild(btn);

    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folder.name || folder.id;
    $("moveTarget").appendChild(opt);
  }
}

async function loadMessages() {
  const query = new URLSearchParams({
    fid: state.fid,
    limit: "50",
    q: $("search").value.trim(),
  });
  if ($("unreadOnly").checked) query.set("unread", "1");
  const payload = await request(`/api/messages?${query}`);
  const messages = unwrap(payload) || [];
  $("messages").innerHTML = "";

  if (!messages.length) {
    $("messages").innerHTML = `<div class="message"><span></span><div><strong>没有邮件</strong><small>当前文件夹为空</small></div></div>`;
    return;
  }

  for (const msg of messages) {
    const id = messageId(msg);
    const row = document.createElement("div");
    row.className = `message${state.selected?.id === id ? " active" : ""}`;
    row.innerHTML = `
      <input type="checkbox" data-id="${id}" onclick="event.stopPropagation()">
      <div>
        <strong>${escapeHtml(messageSubject(msg))}</strong>
        <span>${escapeHtml(messageFrom(msg))}</span>
        <small>${escapeHtml(messageDate(msg))}</small>
      </div>
    `;
    row.onclick = () => openMessage(id, msg);
    $("messages").appendChild(row);
  }
}

async function openMessage(id, summary) {
  state.selected = { id, summary };
  loadMessages();
  $("subject").textContent = messageSubject(summary);
  $("meta").textContent = "正在读取...";
  $("body").textContent = "";
  $("replyBtn").hidden = false;

  const payload = await request(`/api/message?fid=${encodeURIComponent(state.fid)}&id=${encodeURIComponent(id)}`);
  const header = unwrap(payload.header);
  $("meta").textContent = header ? textOf(header) : `${messageFrom(summary)} ${messageDate(summary)}`;
  $("body").textContent = textOf(payload.body);
}

function selectedIds() {
  return [...document.querySelectorAll(".message input:checked")].map((input) => input.dataset.id).filter(Boolean);
}

async function mark(unread) {
  const ids = selectedIds();
  if (!ids.length) return;
  await request("/api/mark", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fid: state.fid, ids, unread }),
  });
  await Promise.all([loadFolders(), loadMessages()]);
}

async function moveSelected() {
  const ids = selectedIds();
  const toFid = $("moveTarget").value;
  if (!ids.length || !toFid) return;
  await request("/api/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fid: state.fid, ids, toFid }),
  });
  await Promise.all([loadFolders(), loadMessages()]);
}

function openComposer(reply = false) {
  state.replyMode = reply;
  $("composeTitle").textContent = reply ? "回复邮件" : "写邮件";
  $("to").value = reply && state.selected ? messageFrom(state.selected.summary) : "";
  $("cc").value = "";
  $("subjectInput").value = reply && state.selected ? `Re: ${messageSubject(state.selected.summary)}` : "";
  $("composeBody").value = "";
  $("attachments").value = "";
  $("sendStatus").textContent = "";
  $("to").disabled = false;
  $("subjectInput").disabled = reply;
  $("composer").showModal();
}

async function sendMail(event) {
  event.preventDefault();
  $("sendStatus").textContent = "发送中...";
  const attachments = $("attachments").value.split("|").map((item) => item.trim()).filter(Boolean);
  const payload = {
    to: $("to").value.trim(),
    cc: $("cc").value.trim(),
    subject: $("subjectInput").value.trim(),
    body: $("composeBody").value,
    attachments,
  };
  const endpoint = state.replyMode ? "/api/reply" : "/api/send";
  if (state.replyMode) {
    payload.id = state.selected.id;
    payload.fid = state.fid;
    payload.overrideTo = payload.to;
  }
  try {
    await request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("sendStatus").textContent = "已发送";
    setTimeout(() => $("composer").close(), 350);
  } catch (error) {
    $("sendStatus").textContent = error.message;
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatAddress(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatAddress).filter(Boolean).join(", ");
  if (value.address) return value.name ? `${value.name} <${value.address}>` : value.address;
  if (value.email) return value.name ? `${value.name} <${value.email}>` : value.email;
  if (value.text) return value.text;
  return JSON.stringify(value);
}

let searchTimer = null;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadMessages, 350);
});
$("unreadOnly").onchange = loadMessages;
$("refresh").onclick = () => Promise.all([loadStatus(), loadFolders(), loadMessages()]);
$("composeBtn").onclick = () => openComposer(false);
$("replyBtn").onclick = () => openComposer(true);
$("markRead").onclick = () => mark(false);
$("markUnread").onclick = () => mark(true);
$("moveBtn").onclick = moveSelected;
$("sendBtn").onclick = sendMail;

Promise.all([loadStatus(), loadFolders()]).then(loadMessages).catch((error) => {
  $("account").textContent = error.message;
});
