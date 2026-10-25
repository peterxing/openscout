// Shared client state, RPC over WebSocket, DOM + Markdown helpers.

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") || sessionStorage.getItem("openscout.token") || "";
if (params.get("token")) {
  sessionStorage.setItem("openscout.token", TOKEN);
  history.replaceState(null, "", location.pathname);
}

export const state = {
  app: null,
  settings: null,
  github: null,
  workiq: null,
  models: [],
  personalities: [],
  sessions: [],
  pending: [],
  automations: [],
  heartbeat: null,
  memory: [],
  skills: [],
  currentId: null,
  currentIsDraft: false,
  view: "chat",
  busy: false,
};

// ── Events & RPC ─────────────────────────────────────────────────────────
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[${event}]`, err);
    }
  }
}

let ws = null;
let nextId = 1;
let retry = 0;
const pending = new Map();

export function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected to OpenScout."));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

export function connect() {
  const banner = document.getElementById("conn-banner");
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    retry = 0;
    banner.hidden = true;
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "Request failed"));
    } else if (msg.event) {
      emit(msg.event, msg.payload);
    }
  };
  ws.onclose = (ev) => {
    for (const p of pending.values()) p.reject(new Error("Connection lost"));
    pending.clear();
    if (ev.code === 1006 && !TOKEN) {
      banner.textContent = "Missing access token — reopen OpenScout from the app or the URL printed in the console.";
      banner.hidden = false;
      return;
    }
    banner.hidden = false;
    setTimeout(connect, Math.min(8000, 400 * 2 ** retry++));
  };
}

// ── DOM helpers ─────────────────────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") deferredValue = v;
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden" || k === "open") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

export function switchEl(checked, onChange, label) {
  return h(
    "label",
    { class: "switch" },
    h("input", { type: "checkbox", checked, onchange: (e) => onChange(e.target.checked) }),
    h("span", { class: "track" }),
    label ? h("span", {}, label) : null,
  );
}

export function select(options, value, onChange, props = {}) {
  return h(
    "select",
    { ...props, value, onchange: (e) => onChange(e.target.value) },
    options.map((o) => (typeof o === "string" ? h("option", { value: o }, o) : h("option", { value: o.value }, o.label))),
  );
}

// ── Formatting ──────────────────────────────────────────────────────────
export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function fmtRelative(iso) {
  if (!iso) return "";
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat([], { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function fmtTokens(n) {
  if (!n) return "0";
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

// ── Markdown ────────────────────────────────────────────────────────────
function fileUrlToPath(url) {
  let p = decodeURIComponent(url.replace(/^file:\/*/i, ""));
  if (/^[a-zA-Z]:/.test(p)) p = p.replace(/\//g, "\\");
  else p = "/" + p;
  return p;
}
export const localFileUrl = (p) => `/local-file?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;

window.marked.use({
  gfm: true,
  breaks: false,
  walkTokens(token) {
    if ((token.type === "image" || token.type === "link") && /^file:/i.test(token.href || "")) {
      const p = fileUrlToPath(token.href);
      token.href = token.type === "image" ? localFileUrl(p) : `#open-file=${encodeURIComponent(p)}`;
    }
  },
  renderer: {
    // Remote images could leak data through their URL (prompt-injection exfiltration), so show them as links.
    image({ href, text }) {
      if (/^https?:/i.test(href || "")) {
        let host = href;
        try {
          host = new URL(href).host;
        } catch {
          // keep raw
        }
        const label = (text || "image").replace(/[<>&"]/g, "");
        return `<a href="${href.replace(/"/g, "%22")}">🖼 ${label} (${host})</a>`;
      }
      return false;
    },
  },
});

export function renderMarkdown(md, { final = true } = {}) {
  const html = window.marked.parse(md || "");
  const box = document.createElement("div");
  box.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  for (const a of box.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#open-file=")) {
      a.dataset.openFile = decodeURIComponent(href.slice("#open-file=".length));
      a.setAttribute("href", "#");
      a.title = a.dataset.openFile;
    } else {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
  for (const pre of [...box.querySelectorAll("pre")]) {
    const code = pre.querySelector("code");
    const lang = /language-([\w-]+)/.exec(code?.className || "")?.[1];
    if (lang === "mermaid" && final) {
      pre.replaceWith(h("div", { class: "mermaid-box", dataset: { src: code.textContent } }, h("span", { class: "spinner" })));
      continue;
    }
    if (code && window.hljs && (!lang || window.hljs.getLanguage(lang))) {
      try {
        window.hljs.highlightElement(code);
      } catch {
        // leave unhighlighted
      }
    }
    const wrap = h("div", { class: "code-wrap" });
    pre.replaceWith(wrap);
    const btn = h(
      "button",
      {
        class: "btn sm copy",
        onclick: () => {
          navigator.clipboard.writeText((code ?? pre).textContent);
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        },
      },
      "Copy",
    );
    wrap.append(pre, btn);
  }
  return box;
}

let mermaidLoad = null;
export async function renderMermaidIn(root) {
  const boxes = [...root.querySelectorAll(".mermaid-box[data-src]")];
  if (!boxes.length) return;
  try {
    if (!window.mermaid) {
      mermaidLoad ??= new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/vendor/mermaid.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.append(s);
      });
      await mermaidLoad;
    }
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark() ? "dark" : "default" });
  } catch {
    for (const b of boxes) b.replaceChildren(h("pre", {}, b.dataset.src));
    return;
  }
  for (const box of boxes) {
    const src = box.dataset.src;
    delete box.dataset.src;
    try {
      const { svg } = await window.mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, src);
      box.innerHTML = svg;
    } catch {
      box.replaceChildren(h("pre", {}, src));
    }
  }
}

// ── Theme ───────────────────────────────────────────────────────────────
const media = window.matchMedia("(prefers-color-scheme: dark)");
export function isDark() {
  return document.documentElement.dataset.theme === "dark";
}
export function applyTheme() {
  const pref = state.settings?.theme ?? "system";
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#hljs-theme").setAttribute("href", dark ? "/vendor/hljs-dark.css" : "/vendor/hljs-light.css");
}
media.addEventListener("change", applyTheme);

// ── Toasts & modals ─────────────────────────────────────────────────────
export function toast(title, body = "", { onClick, error = false, timeout = 7000 } = {}) {
  const el = h("div", { class: `card toast${error ? " error" : ""}` }, h("b", {}, title), body ? h("div", { class: "muted small" }, body.slice(0, 300)) : null);
  el.addEventListener("click", () => {
    el.remove();
    onClick?.();
  });
  $("#toasts").append(el);
  setTimeout(() => el.remove(), timeout);
}

export function modal(build) {
  const root = $("#modal-root");
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  const box = h("div", { class: "card modal" });
  const backdrop = h("div", { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() }, box);
  box.append(...[build(close)].flat());
  root.append(backdrop);
  document.addEventListener("keydown", onKey);
  box.querySelector("input, textarea, select")?.focus();
  return close;
}

export function confirmDialog(title, body, okLabel = "Delete") {
  return new Promise((resolve) => {
    modal((close) => [
      h("h3", {}, title),
      h("div", { class: "muted" }, body),
      h(
        "div",
        { class: "card-actions" },
        h("button", { class: "btn", onclick: () => (close(), resolve(false)) }, "Cancel"),
        h("button", { class: "btn danger", onclick: () => (close(), resolve(true)) }, okLabel),
      ),
    ]);
  });
}

export async function guard(promise, label = "Something went wrong") {
  try {
    return await promise;
  } catch (err) {
    toast(label, err.message, { error: true });
    throw err;
  }
}
