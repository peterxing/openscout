import { $, applyTheme, connect, on, state, toast } from "./core.js";
import { bindViewSwitcher, newChat, openSession, refreshWelcome, renderModels, renderSessionList, statusPill } from "./chat.js";
import { bindOpenSession, renderAutomations, renderMemory, renderSettings, renderSkills } from "./views.js";

const VIEWS = ["chat", "automations", "memory", "skills", "settings"];
const RENDERERS = { automations: renderAutomations, memory: renderMemory, skills: renderSkills, settings: renderSettings };

function setView(view) {
  state.view = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll(".nav-link")) b.classList.toggle("active", b.dataset.view === view);
  if (view !== "chat") renderSessionList();
  RENDERERS[view]?.();
}

/** Re-render a page only when the user isn't typing in it. */
function refreshView(view) {
  if (state.view !== view || !RENDERERS[view]) return;
  const active = document.activeElement;
  if (active && $(`#view-${view}`).contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  RENDERERS[view]();
}

function renderPills() {
  $("#status-pills").replaceChildren(statusPill("github"), statusPill("workiq"));
  refreshWelcome();
}

bindViewSwitcher(setView);
bindOpenSession(openSession);

for (const b of document.querySelectorAll(".nav-link")) b.addEventListener("click", () => setView(b.dataset.view));
$("#new-chat").addEventListener("click", newChat);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newChat();
  }
});

// ── Server events ───────────────────────────────────────────────────────
let first = true;
on("hello", (s) => {
  Object.assign(state, {
    app: s.app,
    settings: s.settings,
    github: s.github,
    workiq: s.workiq,
    models: s.models,
    personalities: s.personalities,
    sessions: s.sessions,
    pending: s.pending,
    automations: s.automations,
    heartbeat: s.heartbeat,
    memory: s.memory,
    skills: s.skills,
  });
  applyTheme();
  renderPills();
  renderModels();
  renderSessionList();
  if (first) {
    first = false;
    newChat();
  } else if (state.currentId && !state.currentIsDraft) {
    openSession(state.currentId);
  }
  refreshView(state.view);
});

on("sessions", (list) => {
  state.sessions = list;
  renderSessionList();
  const meta = list.find((s) => s.id === state.currentId);
  const titleEl = $("#chat-title");
  if (meta && document.activeElement !== titleEl) {
    titleEl.textContent = meta.title;
    titleEl.contentEditable = "true";
  }
});
on("settings.changed", (s) => {
  state.settings = s;
  applyTheme();
  renderModels();
  refreshView("settings");
  refreshView("automations");
  refreshView("skills");
});
on("status.github", (g) => {
  state.github = g;
  renderPills();
  refreshView("settings");
});
on("status.workiq", (w) => {
  state.workiq = w;
  renderPills();
  refreshView("settings");
});
on("models", (m) => {
  state.models = m;
  renderModels();
  refreshView("settings");
});
on("memory.changed", (m) => {
  state.memory = m;
  refreshView("memory");
});
on("skills.changed", (s) => {
  state.skills = s;
  refreshView("skills");
});
on("automations.changed", (a) => {
  state.automations = a;
  refreshView("automations");
});
on("heartbeat", (hb) => {
  state.heartbeat = hb;
  refreshView("automations");
});
on("automation.run", (run) => {
  const a = state.automations.find((x) => x.id === run.automationId);
  if (a) a.running = run.status === "running";
  refreshView("automations");
});
on("notify", (n) => {
  toast(n.title, n.body, { error: n.kind === "error", onClick: n.sessionId ? () => openSession(n.sessionId) : undefined });
  if (state.app?.host === "web" && document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(n.title, { body: n.body, icon: "/assets/icon-64.png" });
  }
});
on("attention", (a) => {
  if (a.sessionId === state.currentId && state.view === "chat" && !document.hidden) return;
  toast(a.kind === "permission" ? "OpenScout needs your approval" : "OpenScout has a question", a.title, { onClick: () => openSession(a.sessionId), timeout: 12000 });
});
on("ui.openSession", (p) => openSession(p.sessionId));
on("ui.newChat", () => newChat());

if (state.app?.host !== "electron" && "Notification" in window && Notification.permission === "default") {
  document.addEventListener("click", () => Notification.requestPermission().catch(() => undefined), { once: true });
}

connect();
