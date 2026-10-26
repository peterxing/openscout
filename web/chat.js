import { $, confirmDialog, fmtTokens, guard, h, localFileUrl, modal, on, renderMarkdown, renderMermaidIn, rpc, state, toast } from "./core.js";

const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");
const stopBtn = $("#stop");
const intentEl = $("#intent");
const titleEl = $("#chat-title");
const modelSel = $("#model-select");
const usageEl = $("#usage");
const listEl = $("#session-list");
const searchEl = $("#session-search");
const slashEl = $("#slash-menu");
const attachEl = $("#attachments");

let live = freshLive();
let attachments = [];
let searchResults = null;
let slashIndex = 0;
let errorIdleTimer = null;
/** Bumped whenever the displayed conversation changes, so late async results can tell they're stale. */
let viewGen = 0;

function freshLive() {
  return { assistant: new Map(), reasoning: new Map(), tools: new Map(), cards: new Map(), optimistic: [] };
}

// ── View plumbing (set by app.js) ─────────────────────────────────────────
let setView = () => {};
export function bindViewSwitcher(fn) {
  setView = fn;
}

// ── Sidebar ─────────────────────────────────────────────────────────────
function bucket(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 days";
  if (diffDays < 30) return "Previous 30 days";
  return "Older";
}

function sessionItem(s, snippet) {
  const status = s.busy ? h("span", { class: "spinner" }) : s.pending ? h("span", { class: "dot", title: "Waiting for you" }) : null;
  return h(
    "div",
    {
      class: `session-item${s.id === state.currentId ? " active" : ""}${snippet !== undefined ? " search-hit" : ""}`,
      title: s.title,
      onclick: () => openSession(s.id),
    },
    status,
    s.origin === "automation" ? h("span", { class: "s-badge", title: s.automationName ? `Automation: ${s.automationName}` : "Automation run" }, "⏱") : null,
    h("span", { class: "s-title" }, s.title, snippet ? h("span", { class: "snippet" }, snippet) : null),
    h(
      "span",
      { class: "s-actions" },
      h("button", { class: "icon-btn", title: "Rename", onclick: (e) => (e.stopPropagation(), renameSession(s.id, s.title)) }, "✎"),
      h("button", { class: "icon-btn", title: "Delete", onclick: (e) => (e.stopPropagation(), deleteSession(s.id, s.title)) }, "🗑"),
    ),
  );
}

export function renderSessionList() {
  if (searchResults) {
    listEl.replaceChildren(
      h("div", { class: "group-label" }, `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`),
      ...searchResults.map((r) => sessionItem({ ...(state.sessions.find((s) => s.id === r.sessionId) ?? {}), id: r.sessionId, title: r.title }, r.snippet || "")),
    );
    return;
  }
  if (!state.sessions.length) {
    listEl.replaceChildren(h("div", { class: "empty small" }, "No conversations yet."));
    return;
  }
  const groups = new Map();
  for (const s of state.sessions) {
    const b = bucket(s.updatedAt);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(s);
  }
  listEl.replaceChildren(...[...groups].flatMap(([label, items]) => [h("div", { class: "group-label" }, label), ...items.map((s) => sessionItem(s))]));
}

let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  searchTimer = setTimeout(async () => {
    searchResults = q ? await rpc("session.search", { query: q }).catch(() => []) : null;
    renderSessionList();
  }, 250);
});

function renameSession(id, current) {
  modal((close) => {
    const input = h("input", { type: "text", value: current, style: { width: "100%" } });
    const save = async () => {
      const title = input.value.trim();
      if (title) await guard(rpc("session.rename", { id, title }));
      close();
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && save());
    return [
      h("h3", {}, "Rename conversation"),
      input,
      h("div", { class: "card-actions" }, h("button", { class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: save }, "Save")),
    ];
  });
}

async function deleteSession(id, title) {
  if (!(await confirmDialog("Delete conversation?", `“${title}” will be removed permanently.`))) return;
  await guard(rpc("session.delete", { id }));
  if (state.currentId === id) newChat();
}

// ── Header ──────────────────────────────────────────────────────────────
export function renderModels() {
  const current = currentMeta()?.model ?? state.settings?.defaultModel ?? "auto";
  const models = state.models.length ? state.models : [{ id: "auto", name: "Auto" }];
  const opts = models.map((m) => h("option", { value: m.id }, `${m.name}${m.multiplier !== undefined && m.multiplier !== 1 ? ` · ${m.multiplier}×` : ""}`));
  if (!models.some((m) => m.id === current)) opts.unshift(h("option", { value: current }, current));
  modelSel.replaceChildren(...opts);
  modelSel.value = current;
}

modelSel.addEventListener("change", async () => {
  if (state.currentId && !state.currentIsDraft) await guard(rpc("session.setModel", { id: state.currentId, model: modelSel.value }));
});

function currentMeta() {
  return state.sessions.find((s) => s.id === state.currentId);
}

function renderHeader() {
  const meta = currentMeta();
  titleEl.textContent = meta?.title ?? (state.currentId ? titleEl.textContent : "New conversation");
  titleEl.contentEditable = meta ? "true" : "false";
  renderUsage(meta?.usage);
}

function renderUsage(u) {
  if (!u?.tokenLimit) {
    usageEl.textContent = "";
    return;
  }
  const pct = Math.round((u.currentTokens / u.tokenLimit) * 100);
  usageEl.textContent = `${fmtTokens(u.currentTokens)} / ${fmtTokens(u.tokenLimit)} (${pct}%)`;
}

titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    titleEl.blur();
  }
});
titleEl.addEventListener("blur", async () => {
  const meta = currentMeta();
  const title = titleEl.textContent.trim();
  if (meta && title && title !== meta.title) await guard(rpc("session.rename", { id: meta.id, title }));
});

// ── Messages ────────────────────────────────────────────────────────────
function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}
function scrollToBottom(force = false) {
  if (force || nearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}
function appendRow(child) {
  const stick = nearBottom();
  const row = h("div", { class: "msg-row" }, child);
  messagesEl.append(row);
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  return row;
}

function userBubble(text, attachmentNames = []) {
  return h("div", { class: "msg user" }, text, attachmentNames.length ? h("div", {}, attachmentNames.map((n) => h("span", { class: "att" }, `📎 ${n}`))) : null);
}

function assistantBubble(text, final = true) {
  const el = h("div", { class: `msg assistant${final ? "" : " streaming"}` });
  el.append(...renderMarkdown(text, { final }).childNodes);
  if (final) void renderMermaidIn(el);
  return el;
}

const TOOL_LABELS = {
  m365_search: "Searched Microsoft 365",
  m365_fetch: "Read Microsoft 365",
  m365_function: "Queried Microsoft 365",
  m365_fetch_file: "Downloaded a file",
  m365_create: "Created in Microsoft 365",
  m365_update: "Updated Microsoft 365",
  m365_delete: "Deleted in Microsoft 365",
  m365_action: "Microsoft 365 action",
  m365_get_schema: "Looked up a schema",
  m365_search_paths: "Looked up Microsoft 365 paths",
  m365_copilot_ask: "Asked Microsoft 365 Copilot",
  m365_copilot_retrieve: "Retrieved from Microsoft 365 Copilot",
  powershell: "Ran a command",
  bash: "Ran a command",
  web_search: "Searched the web",
  web_fetch: "Fetched a web page",
  view: "Read a file",
  glob: "Listed files",
  grep: "Searched files",
  apply_patch: "Edited files",
  edit: "Edited a file",
  create: "Created a file",
  skill: "Loaded a skill",
  task: "Ran a sub-agent",
  memory_remember: "Saved to memory",
  memory_recall: "Checked memory",
  automation_create: "Created an automation",
  automation_update: "Updated an automation",
  ask_user: "Asked you",
};

function toolIcon(name, server) {
  if (name.startsWith("m365_")) return "🗂";
  if (server === "playwright" || name.startsWith("playwright-") || name.startsWith("browser_")) return "🌐";
  if (/^(powershell|bash|shell|read_powershell|write_powershell)/.test(name)) return "⌨";
  if (name.startsWith("web_")) return "🔎";
  if (name.startsWith("memory_")) return "🧠";
  if (name.startsWith("automation_")) return "⏱";
  if (/^(view|edit|create|apply_patch|glob|grep)$/.test(name)) return "📄";
  if (name === "skill" || name.startsWith("skill_")) return "🧩";
  return "🔧";
}

function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const browser = /^(?:playwright-)?browser_(.+)$/.exec(name);
  if (browser) return `Browser: ${browser[1].replace(/_/g, " ")}`;
  return name.replace(/^[\w]+-/, "").replace(/_/g, " ");
}

function argSummary(name, argsText) {
  let a;
  try {
    a = JSON.parse(argsText);
  } catch {
    return argsText?.slice(0, 160) ?? "";
  }
  if (!a || typeof a !== "object") return String(a ?? "");
  const pick =
    a.query ?? a.command ?? a.url ?? a.path ?? a.entityUrls?.[0] ?? a.functionUrl ?? a.actionUrl ?? a.parentUrl ?? a.entityUrl ?? a.question ?? a.fact ?? a.name ?? a.description ?? a.pattern ?? a.prompt;
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").slice(0, 200);
  return Object.entries(a)
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 200);
}

function toolCard({ name, server, args, success, result, running }) {
  const status = h("span", { class: "t-status" }, running ? h("span", { class: "spinner" }) : success === false ? h("span", { class: "err-mark" }, "✗") : h("span", { class: "ok-mark" }, "✓"));
  const resultPre = h("pre", {}, result ?? "");
  const body = h(
    "div",
    { class: "t-body" },
    h("div", { class: "muted small" }, `Tool: ${name}${server ? ` (${server})` : ""}`),
    args && args !== "{}" ? h("pre", {}, args) : null,
    h("div", { class: "muted small" }, "Result"),
    resultPre,
  );
  const el = h(
    "details",
    { class: "tool" },
    h("summary", {}, h("span", {}, toolIcon(name, server)), h("span", { class: "t-name" }, toolLabel(name)), h("span", { class: "t-arg" }, argSummary(name, args)), status),
    body,
  );
  el._status = status;
  el._result = resultPre;
  return el;
}

function infoLine(text) {
  return h("div", { class: "info-line" }, text);
}

function errorBox(text) {
  return h("div", { class: "error-box" }, text);
}

function permissionCard(p) {
  const actions = h("div", { class: "card-actions" });
  const feedback = h("input", { type: "text", placeholder: "Optional: tell OpenScout why or what to do instead" });
  const respond = async (decision) => {
    actions.replaceChildren(h("span", { class: "spinner" }));
    try {
      await rpc("permission.respond", { requestId: p.requestId, decision, feedback: feedback.value.trim() || undefined });
    } catch (err) {
      toast("Couldn't send your answer", err.message, { error: true });
    }
  };
  actions.append(
    h("button", { class: "btn primary", onclick: () => respond("once") }, "Allow"),
    p.allowSession ? h("button", { class: "btn", onclick: () => respond("session") }, "Allow for this conversation") : null,
    h("button", { class: "btn danger", onclick: () => respond("deny") }, "Deny"),
    feedback,
  );
  const riskNote = p.risk === "high" ? h("span", { class: "badge err" }, "changes data or sends") : p.readOnly ? h("span", { class: "badge ok" }, "read-only") : h("span", { class: "badge warn" }, "makes changes");
  const card = h(
    "div",
    { class: `card perm risk-${p.risk}` },
    h("h4", {}, "🔐 ", p.title, " ", riskNote),
    p.intention ? h("div", { class: "intention" }, p.intention) : null,
    p.detail ? h("pre", {}, p.detail) : null,
    actions,
  );
  card._resolve = (decision) => {
    const label = decision === "deny" ? "✗ Denied" : decision === "session" ? "✓ Allowed for this conversation" : "✓ Allowed";
    actions.replaceWith(h("div", { class: "resolved" }, label));
  };
  return card;
}

function inputCard(q) {
  const actions = h("div", { class: "card-actions" });
  const free = h("input", { type: "text", placeholder: "Type your answer…" });
  const answer = async (text, wasFreeform) => {
    if (!text.trim()) return;
    actions.replaceChildren(h("span", { class: "spinner" }));
    try {
      await rpc("input.respond", { requestId: q.requestId, answer: text, wasFreeform });
    } catch (err) {
      toast("Couldn't send your answer", err.message, { error: true });
    }
  };
  free.addEventListener("keydown", (e) => e.key === "Enter" && answer(free.value, true));
  for (const c of q.choices ?? []) actions.append(h("button", { class: "btn choice", onclick: () => answer(c, false) }, c));
  if (q.allowFreeform !== false) actions.append(free, h("button", { class: "btn primary", onclick: () => answer(free.value, true) }, "Answer"));
  const card = h("div", { class: "card ask" }, h("h4", {}, "💬 ", q.question), actions);
  card._resolve = (text) => actions.replaceWith(h("div", { class: "resolved" }, `You answered: ${text}`));
  return card;
}

function renderEntry(e) {
  switch (e.kind) {
    case "user":
      appendRow(userBubble(e.text, e.attachments));
      break;
    case "assistant":
      appendRow(assistantBubble(e.text));
      break;
    case "tool":
      appendRow(toolCard({ name: e.name, server: e.server, args: e.args, success: e.success, result: e.result }));
      break;
    case "permission":
      appendRow(infoLine(`${e.decision === "deny" ? "✗ Denied" : "✓ Allowed"}: ${e.title}`));
      break;
    case "input":
      appendRow(infoLine(`Asked: ${e.question} — you answered “${e.answer}”`));
      break;
    case "error":
      appendRow(errorBox(e.text));
      break;
    default:
      appendRow(infoLine(e.text));
  }
}

function renderPending(p) {
  if (p.type === "permission") {
    const card = permissionCard(p);
    live.cards.set(p.requestId, card);
    appendRow(card);
  } else if (p.type === "input") {
    const card = inputCard(p);
    live.cards.set(p.requestId, card);
    appendRow(card);
  }
}

// ── Welcome ─────────────────────────────────────────────────────────────
const SUGGESTIONS = {
  work: [
    ["Today's meetings", "What's on my calendar today? Flag conflicts and anything I need to prepare."],
    ["Inbox triage", "Summarise my unread email from the last 24 hours and tell me which ones need a reply."],
    ["Teams catch-up", "Catch me up on Teams chats from today that mention me or ask me something."],
    ["Find my decks", "Find the PowerPoint decks I worked on most recently and list them with links."],
    ["Morning briefing", "Create an automation that every weekday at 8am briefs me on my meetings, urgent email and Teams mentions."],
    ["What can you do?", "What can you do for me? Give me a quick tour of your capabilities."],
  ],
  student: [
    ["Today's classes", "What classes and study sessions do I have today? Flag clashes and anything I need to prepare."],
    ["Assignments due", "What assignments and deadlines do I have in the next two weeks? Check my school email and Teams class posts, and sort them by due date."],
    ["Lecture notes", "Find the latest lecture slides in my OneDrive and turn them into concise notes with three practice questions."],
    ["Email my tutor", "Draft a polite email to my tutor asking for a one-week extension on my assignment because I've been unwell."],
    ["Weekly study plan", "Create an automation that every Sunday at 6pm plans my study week around my classes and deadlines in 45-minute blocks."],
    ["Quiz me", "Quiz me on a topic I choose. Ask me which topic first, then give me five questions with answers I can reveal."],
  ],
};

function greeting() {
  const hr = new Date().getHours();
  const part = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const first = state.m365?.user?.displayName?.split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export function statusPill(kind) {
  if (kind === "github") {
    const g = state.github;
    const ok = g?.state === "signed-in";
    const cls = ok ? "ok" : g?.state === "starting" ? "warn" : "err";
    const text = ok ? `GitHub Copilot · ${g.login}` : g?.state === "starting" ? "GitHub Copilot · starting…" : "GitHub Copilot · not signed in";
    return h("div", { class: "pill", title: g?.message ?? text, onclick: () => setView("settings") }, h("span", { class: `status-dot ${cls}` }), text);
  }
  const m = state.m365;
  const ok = m?.state === "ready";
  const cls = ok ? "ok" : m?.state === "starting" || m?.state === "signing-in" ? "warn" : m?.state === "disabled" ? "" : "err";
  const labels = { starting: "connecting…", "signing-in": "signing in…", "signed-out": "sign in needed", eula: "accept terms", error: "error", missing: "not installed", disabled: "off" };
  const text = ok ? `Microsoft 365 · ${m.user?.displayName ?? "connected"}` : `Microsoft 365 · ${labels[m?.state] ?? "…"}`;
  return h("div", { class: "pill", title: m?.message ?? text, onclick: () => setView("settings") }, h("span", { class: `status-dot ${cls}` }), text);
}

function renderWelcome() {
  const student = state.settings?.audience === "student";
  messagesEl.replaceChildren(
    h(
      "div",
      { class: "welcome" },
      h("img", { src: "assets/icon.png", alt: "" }),
      h("h2", {}, greeting()),
      h(
        "div",
        { class: "muted" },
        student
          ? "Your study assistant — GitHub Copilot models, with your school Microsoft 365 account for classes, email, Teams and files."
          : "Your desktop work assistant — GitHub Copilot models, with your Microsoft 365 mail, calendar, Teams and files.",
      ),
      h("div", { class: "checks" }, statusPill("github"), statusPill("m365")),
      h(
        "div",
        { class: "suggestions" },
        SUGGESTIONS[student ? "student" : "work"].map(([t, p]) => h("div", { class: "suggestion", onclick: () => send(p) }, h("b", {}, t), h("span", { class: "muted small" }, p))),
      ),
    ),
  );
}

export function refreshWelcome() {
  if (!state.currentId && messagesEl.querySelector(".welcome")) renderWelcome();
}

// ── Opening conversations ─────────────────────────────────────────────────
export function newChat() {
  viewGen++;
  clearTimeout(errorIdleTimer);
  state.currentId = null;
  state.currentIsDraft = false;
  live = freshLive();
  setBusy(false);
  setView("chat");
  renderWelcome();
  renderHeader();
  renderModels();
  renderSessionList();
  inputEl.focus();
}

export async function openSession(id) {
  const gen = ++viewGen;
  clearTimeout(errorIdleTimer);
  state.currentId = id;
  state.currentIsDraft = false;
  live = freshLive();
  setView("chat");
  renderSessionList();
  renderHeader();
  renderModels();
  messagesEl.replaceChildren(h("div", { class: "info-line" }, h("span", { class: "spinner" })));
  let data;
  try {
    data = await rpc("session.open", { id });
  } catch (err) {
    if (gen === viewGen) messagesEl.replaceChildren(errorBox(err.message));
    return;
  }
  if (gen !== viewGen) return;
  messagesEl.replaceChildren();
  for (const e of data.transcript) renderEntry(e);
  for (const p of data.pending) renderPending(p);
  if (!data.transcript.length && !data.pending.length) messagesEl.append(h("div", { class: "empty" }, "This conversation is empty."));
  setBusy(data.busy);
  renderUsage(data.meta.usage);
  scrollToBottom(true);
  void renderMermaidIn(messagesEl);
}

function setBusy(busy) {
  state.busy = busy;
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  if (busy) {
    intentEl.replaceChildren(h("span", { class: "spinner" }), " Working…");
  } else {
    intentEl.textContent = "";
    for (const m of live.assistant.values()) m.el.classList.remove("streaming");
  }
}

// ── Live events ─────────────────────────────────────────────────────────
function onDelta(messageId, delta) {
  let m = live.assistant.get(messageId);
  if (!m) {
    const el = h("div", { class: "msg assistant streaming" });
    m = { el, row: appendRow(el), text: "", timer: null };
    live.assistant.set(messageId, m);
  }
  m.text += delta;
  if (!m.timer) {
    m.timer = setTimeout(() => {
      m.timer = null;
      const stick = nearBottom();
      m.el.replaceChildren(...renderMarkdown(m.text, { final: false }).childNodes);
      if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 60);
  }
}

function onAssistantMessage(messageId, text) {
  const m = live.assistant.get(messageId);
  if (m?.timer) clearTimeout(m.timer);
  if (!text.trim()) {
    m?.row.remove();
    live.assistant.delete(messageId);
    return;
  }
  const stick = nearBottom();
  if (m) {
    m.text = text;
    m.timer = null;
    m.el.classList.remove("streaming");
    m.el.replaceChildren(...renderMarkdown(text).childNodes);
    void renderMermaidIn(m.el);
  } else {
    const el = assistantBubble(text);
    live.assistant.set(messageId, { el, row: appendRow(el), text, timer: null });
  }
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function onReasoning(id, delta) {
  let r = live.reasoning.get(id);
  if (!r) {
    const body = h("div", { class: "r-body" });
    const el = h("details", { class: "reasoning" }, h("summary", {}, "Thinking…"), body);
    appendRow(el);
    r = { el, body };
    live.reasoning.set(id, r);
  }
  r.body.textContent += delta;
}

on("session.event", (ev) => {
  if (ev.sessionId !== state.currentId) return;
  switch (ev.kind) {
    case "user": {
      const i = live.optimistic.indexOf(ev.text);
      if (i >= 0) live.optimistic.splice(i, 1);
      else appendRow(userBubble(ev.text, ev.attachments));
      setBusy(true);
      break;
    }
    case "assistant.delta":
      onDelta(ev.messageId, ev.delta);
      break;
    case "assistant.message":
      onAssistantMessage(ev.messageId, ev.text ?? "");
      break;
    case "reasoning.delta":
      onReasoning(ev.reasoningId, ev.delta);
      break;
    case "intent":
      if (state.busy) intentEl.replaceChildren(h("span", { class: "spinner" }), ` ${ev.intent}…`);
      break;
    case "tool.start": {
      const card = toolCard({ name: ev.name, server: ev.server, args: ev.args, running: true });
      live.tools.set(ev.toolCallId, card);
      appendRow(card);
      break;
    }
    case "tool.complete": {
      const card = live.tools.get(ev.toolCallId);
      if (!card) break;
      card._status.replaceChildren(ev.success === false ? h("span", { class: "err-mark" }, "✗") : h("span", { class: "ok-mark" }, "✓"));
      card._result.textContent = ev.result ?? "";
      break;
    }
    case "permission.request":
      renderPending({ ...ev, type: "permission" });
      break;
    case "input.request":
      renderPending({ ...ev, type: "input" });
      break;
    case "permission.resolved":
      live.cards.get(ev.requestId)?._resolve?.(ev.decision);
      break;
    case "input.resolved":
      live.cards.get(ev.requestId)?._resolve?.(ev.answer);
      break;
    case "usage":
      renderUsage(ev);
      break;
    case "info":
      appendRow(infoLine(ev.text));
      break;
    case "error":
      appendRow(errorBox(ev.text));
      clearTimeout(errorIdleTimer);
      errorIdleTimer = setTimeout(() => setBusy(false), 4000);
      break;
    case "idle":
      clearTimeout(errorIdleTimer);
      setBusy(false);
      break;
  }
});

// Clicking a file:/// link opens it with the OS (files that can run code are only revealed in Explorer).
messagesEl.addEventListener("click", async (e) => {
  const a = e.target.closest("a[data-open-file]");
  if (!a) return;
  e.preventDefault();
  const r = await guard(rpc("os.openPath", { path: a.dataset.openFile }), "Couldn't open file").catch(() => null);
  if (r?.revealed) toast("Shown in folder", "That file type can run code, so OpenScout selected it in Explorer instead of opening it.");
});

// ── Composer ────────────────────────────────────────────────────────────
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
}

export async function send(textArg) {
  const text = (textArg ?? inputEl.value).trim();
  if (!text || state.busy) return;
  if (text === "/new") {
    inputEl.value = "";
    newChat();
    return;
  }
  const isNew = !state.currentId || state.currentIsDraft;
  const id = state.currentId || crypto.randomUUID();
  if (!state.currentId) {
    state.currentId = id;
    state.currentIsDraft = true;
    live = freshLive();
    messagesEl.replaceChildren();
    titleEl.textContent = text.split("\n")[0].slice(0, 60);
  }
  const atts = attachments.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
  live.optimistic.push(text);
  appendRow(userBubble(text, atts.map((a) => a.name)));
  scrollToBottom(true);
  inputEl.value = "";
  autosize();
  attachments = [];
  renderAttachments();
  hideSlash();
  setBusy(true);
  const gen = viewGen;
  try {
    const res = await rpc("session.send", { sessionId: id, isNew, prompt: text, attachments: atts, model: isNew ? modelSel.value : undefined });
    if (gen !== viewGen) return;
    state.currentIsDraft = false;
    if (res?.sessionId && res.sessionId !== state.currentId) state.currentId = res.sessionId;
  } catch (err) {
    if (gen !== viewGen) {
      // The user has moved to another conversation; don't touch what's on screen.
      toast("Message not sent", err.message, { error: true });
      return;
    }
    setBusy(false);
    appendRow(errorBox(err.message));
    if (isNew) {
      state.currentId = null;
      state.currentIsDraft = false;
    }
  }
}

sendBtn.addEventListener("click", () => send());
stopBtn.addEventListener("click", () => state.currentId && guard(rpc("session.abort", { id: state.currentId })));
inputEl.addEventListener("input", () => {
  autosize();
  updateSlash();
});
inputEl.addEventListener("keydown", (e) => {
  if (!slashEl.hidden) {
    const items = [...slashEl.querySelectorAll(".slash-item")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle("sel", i === slashIndex));
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && items[slashIndex]) {
      e.preventDefault();
      items[slashIndex].click();
      return;
    }
    if (e.key === "Escape") {
      hideSlash();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

function hideSlash() {
  slashEl.hidden = true;
}

function updateSlash() {
  const m = /^\/([\w-]*)$/.exec(inputEl.value);
  if (!m) return hideSlash();
  const q = m[1].toLowerCase();
  const items = [
    { name: "new", description: "Start a new conversation" },
    ...state.skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description })),
  ].filter((s) => s.name.toLowerCase().includes(q));
  if (!items.length) return hideSlash();
  slashIndex = 0;
  slashEl.replaceChildren(
    ...items.slice(0, 30).map((s, i) =>
      h(
        "div",
        {
          class: `slash-item${i === 0 ? " sel" : ""}`,
          onclick: () => {
            inputEl.value = s.name === "new" ? "/new" : `/${s.name} `;
            hideSlash();
            inputEl.focus();
            if (s.name === "new") send();
          },
        },
        h("b", {}, `/${s.name}`),
        h("span", { class: "d" }, s.description),
      ),
    ),
  );
  slashEl.hidden = false;
}

// Attachments (images): picker, paste and drag-and-drop.
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) {
      toast("Only images can be attached", "For other files, paste the file path into your message instead.");
      continue;
    }
    if (f.size > 8 * 1024 * 1024) {
      toast("Image too large", `${f.name} is over 8 MB.`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      attachments.push({ type: "blob", mimeType: f.type, name: f.name || "pasted-image.png", data: dataUrl.split(",")[1], preview: dataUrl });
      renderAttachments();
    };
    reader.readAsDataURL(f);
  }
}

function renderAttachments() {
  attachEl.replaceChildren(
    ...attachments.map((a, i) =>
      h(
        "div",
        { class: "att-chip" },
        h("img", { src: a.preview, alt: "" }),
        h("span", {}, a.name.slice(0, 28)),
        h("button", { class: "icon-btn", title: "Remove", onclick: () => (attachments.splice(i, 1), renderAttachments()) }, "✕"),
      ),
    ),
  );
}

$("#attach").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
});
inputEl.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
$("#composer").addEventListener("dragover", (e) => e.preventDefault());
$("#composer").addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles(e.dataTransfer?.files ?? []);
});

export function focusComposer() {
  inputEl.focus();
}

export { localFileUrl };
