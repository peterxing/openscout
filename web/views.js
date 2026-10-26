import { $, confirmDialog, fmtRelative, fmtTime, guard, h, modal, rpc, select, state, switchEl, toast } from "./core.js";

let openSessionFn = () => {};
export function bindOpenSession(fn) {
  openSessionFn = fn;
}

const STATUS_BADGE = {
  ok: ["ok", "completed"],
  quiet: ["", "nothing to report"],
  error: ["err", "failed"],
  running: ["accent", "running"],
  "not-met": ["", "condition not met"],
};

function statusBadge(status) {
  if (!status) return null;
  const [cls, label] = STATUS_BADGE[status] ?? ["", status];
  return h("span", { class: `badge ${cls}` }, label);
}

function page(id, ...children) {
  const root = $(`#view-${id}`);
  root.replaceChildren(h("div", { class: "page-inner" }, ...children));
}

function header(title, subtitle, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), subtitle ? h("div", { class: "muted" }, subtitle) : null), ...actions);
}

// ── Automations ─────────────────────────────────────────────────────────
export function renderAutomations() {
  const hb = state.settings.heartbeat;
  const hbInfo = state.heartbeat ?? {};
  const heartbeat = h(
    "div",
    { class: "card section" },
    h(
      "div",
      { class: "row" },
      h("div", { style: { flex: 1 } }, h("div", { class: "item-title" }, "💓 Heartbeat"), h("div", { class: "muted small" }, "A periodic check-in on your mail, meetings and Teams that only pings you when something needs attention.")),
      switchEl(hb.enabled, (v) => saveSettings({ heartbeat: { enabled: v } })),
    ),
    h(
      "div",
      { class: "row" },
      h("span", { class: "muted small" }, "Every"),
      select(
        [15, 30, 60, 120].map((m) => ({ value: String(m), label: m < 60 ? `${m} minutes` : m === 60 ? "hour" : "2 hours" })),
        String(hb.intervalMinutes),
        (v) => saveSettings({ heartbeat: { intervalMinutes: Number(v) } }),
      ),
      select(
        [
          { value: "work-hours", label: "during work hours" },
          { value: "always", label: "around the clock" },
        ],
        hb.schedule,
        (v) => saveSettings({ heartbeat: { schedule: v } }),
      ),
      h("span", { class: "muted small" }, "Email me:"),
      select(["never", "auto", "always"], hb.emailNotify, (v) => saveSettings({ heartbeat: { emailNotify: v } })),
      h("span", { style: { flex: 1 } }),
      hbInfo.running ? h("span", { class: "badge accent" }, "running") : hb.enabled && hbInfo.nextRunAt ? h("span", { class: "muted small" }, `next ${fmtRelative(hbInfo.nextRunAt)}`) : null,
      h("button", { class: "btn sm", disabled: Boolean(hbInfo.running), onclick: () => guard(rpc("automation.run", { id: "heartbeat" })).then(() => toast("Heartbeat started", "You'll get a notification when it finishes.")) }, "Run now"),
    ),
    h(
      "details",
      { style: { marginTop: "10px" } },
      h("summary", { class: "muted small" }, "What the heartbeat checks"),
      h("textarea", { rows: 4, style: { width: "100%", marginTop: "6px" }, value: hb.prompt, onchange: (e) => saveSettings({ heartbeat: { prompt: e.target.value } }) }),
    ),
  );

  const items = state.automations.map((a) =>
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { style: { flex: 1, minWidth: "240px" } },
          h("div", { class: "item-title" }, a.trigger === "condition" ? "👁 " : "⏱ ", a.name, " ", a.allowActions ? h("span", { class: "badge warn" }, "can take actions") : h("span", { class: "badge" }, "read-only")),
          h("div", { class: "muted small" }, a.scheduleText, a.enabled && a.nextRunAt ? ` · next ${fmtRelative(a.nextRunAt)}` : "", !a.enabled ? " · paused" : ""),
          a.description ? h("div", { class: "small" }, a.description) : null,
        ),
        a.running ? h("span", { class: "badge accent" }, "running") : statusBadge(a.lastStatus),
        switchEl(a.enabled, (v) => guard(rpc("automation.update", { id: a.id, input: { enabled: v } }))),
      ),
      a.lastSummary
        ? h(
            "details",
            {},
            h("summary", { class: "muted small" }, `Last run ${fmtTime(a.lastRunAt)}`),
            h("div", { class: "summary-box" }, a.lastSummary),
            a.lastSessionId ? h("button", { class: "btn sm", style: { marginTop: "6px" }, onclick: () => openSessionFn(a.lastSessionId) }, "Open conversation") : null,
          )
        : null,
      h(
        "div",
        { class: "card-actions", style: { justifyContent: "flex-start" } },
        h("button", { class: "btn sm", disabled: a.running, onclick: () => guard(rpc("automation.run", { id: a.id })).then(() => toast(`Started “${a.name}”`, "You'll get a notification when it finishes.")) }, "▶ Run now"),
        h("button", { class: "btn sm", onclick: () => editAutomation(a) }, "Edit"),
        h("button", { class: "btn sm", onclick: () => showRuns(a) }, "History"),
        h(
          "button",
          {
            class: "btn sm danger",
            onclick: async () => {
              if (await confirmDialog("Delete automation?", `“${a.name}” and its schedule will be removed.`)) await guard(rpc("automation.delete", { id: a.id }));
            },
          },
          "Delete",
        ),
      ),
    ),
  );

  page(
    "automations",
    header("Automations", "Prompts that run on a schedule or when a condition is met — even while you're away.", h("button", { class: "btn primary", onclick: () => editAutomation(null) }, "＋ New automation")),
    heartbeat,
    h("div", { class: "list" }, items.length ? items : h("div", { class: "empty" }, "No automations yet. Create one here, or just ask in chat: “every weekday at 8am, brief me on my day”.")),
  );
}

function editAutomation(existing) {
  const a = existing ?? { name: "", description: "", steps: [{ label: "Step 1", prompt: "" }], trigger: "schedule", schedule: "every weekday at 9am", checkEveryMinutes: 15, model: "", enabled: true, oneShot: false, allowActions: false, notify: { desktop: true, email: "never" } };
  const form = {
    name: a.name,
    description: a.description ?? "",
    steps: a.steps.map((s) => ({ label: s.label, prompt: s.prompt })),
    trigger: a.trigger,
    schedule: a.schedule || "every weekday at 9am",
    condition: a.condition ?? "",
    checkEveryMinutes: a.checkEveryMinutes ?? 15,
    model: a.model ?? "",
    oneShot: a.oneShot,
    allowActions: a.allowActions,
    desktop: a.notify?.desktop ?? true,
    email: a.notify?.email ?? "never",
  };
  modal((close) => {
    const preview = h("div", { class: "help" });
    let previewTimer = null;
    const updatePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const r = await rpc("schedule.preview", { text: form.schedule }).catch((e) => ({ ok: false, error: e.message }));
        preview.textContent = r.ok ? `✓ ${r.description}${r.next ? ` — next: ${new Date(r.next).toLocaleString()}` : ""}` : `⚠ ${r.error}`;
        preview.style.color = r.ok ? "" : "var(--danger)";
      }, 250);
    };
    const stepsBox = h("div");
    const renderSteps = () =>
      stepsBox.replaceChildren(
        ...form.steps.map((s, i) =>
          h(
            "div",
            { class: "step-row" },
            h("textarea", { placeholder: i === 0 ? "e.g. Summarise my unread email from the last 12 hours and list anything urgent." : "Next step…", value: s.prompt, oninput: (e) => (s.prompt = e.target.value) }),
            form.steps.length > 1 ? h("button", { class: "icon-btn", title: "Remove step", onclick: () => (form.steps.splice(i, 1), renderSteps()) }, "✕") : null,
          ),
        ),
        h("button", { class: "btn sm", onclick: () => (form.steps.push({ label: `Step ${form.steps.length + 1}`, prompt: "" }), renderSteps()) }, "＋ Add step"),
      );
    renderSteps();
    const scheduleField = h(
      "div",
      { class: "field" },
      h("label", {}, "Schedule"),
      h("input", { type: "text", value: form.schedule, oninput: (e) => ((form.schedule = e.target.value), updatePreview()) }),
      preview,
    );
    const conditionField = h(
      "div",
      { class: "field" },
      h("label", {}, "Run once when…"),
      h("input", { type: "text", placeholder: "e.g. an email from Contoso about the renewal arrives", value: form.condition, oninput: (e) => (form.condition = e.target.value) }),
      h("div", { class: "row" }, h("span", { class: "help" }, "Check every"), select(["5", "15", "30", "60"], String(form.checkEveryMinutes), (v) => (form.checkEveryMinutes = Number(v))), h("span", { class: "help" }, "minutes")),
    );
    const syncTrigger = () => {
      scheduleField.hidden = form.trigger !== "schedule";
      conditionField.hidden = form.trigger !== "condition";
    };
    syncTrigger();
    updatePreview();
    const models = [{ value: "", label: "Default model" }, ...state.models.map((m) => ({ value: m.id, label: m.name }))];
    const save = async () => {
      const input = {
        name: form.name.trim() || "Untitled automation",
        description: form.description,
        steps: form.steps.filter((s) => s.prompt.trim()),
        trigger: form.trigger,
        schedule: form.trigger === "schedule" ? form.schedule : undefined,
        condition: form.trigger === "condition" ? form.condition : undefined,
        checkEveryMinutes: form.checkEveryMinutes,
        model: form.model,
        oneShot: form.oneShot,
        allowActions: form.allowActions,
        notify: { desktop: form.desktop, email: form.email },
      };
      try {
        if (existing) await rpc("automation.update", { id: existing.id, input });
        else await rpc("automation.create", { input });
        close();
      } catch (err) {
        toast("Couldn't save automation", err.message, { error: true });
      }
    };
    return [
      h("h3", {}, existing ? "Edit automation" : "New automation"),
      h("div", { class: "field" }, h("label", {}, "Name"), h("input", { type: "text", value: form.name, placeholder: "Morning briefing", oninput: (e) => (form.name = e.target.value) })),
      h(
        "div",
        { class: "field" },
        h("label", {}, "Trigger"),
        select(
          [
            { value: "schedule", label: "On a schedule" },
            { value: "condition", label: "When a condition is met (runs once)" },
          ],
          form.trigger,
          (v) => ((form.trigger = v), syncTrigger()),
        ),
      ),
      scheduleField,
      conditionField,
      h("div", { class: "field" }, h("label", {}, "What should OpenScout do?"), stepsBox, h("div", { class: "help" }, "Runs happen without you, so make the instructions self-contained.")),
      h("div", { class: "field" }, h("label", {}, "Model"), select(models, form.model, (v) => (form.model = v))),
      h(
        "div",
        { class: "field" },
        switchEl(form.allowActions, (v) => (form.allowActions = v), "Allow actions (send mail, post messages, change data) without asking"),
        h("div", { class: "help" }, "Off by default: runs are read-only and draft anything they'd send."),
      ),
      h("div", { class: "field" }, switchEl(form.oneShot, (v) => (form.oneShot = v), "Run once, then pause")),
      h(
        "div",
        { class: "row" },
        switchEl(form.desktop, (v) => (form.desktop = v), "Desktop notification"),
        h("span", { class: "muted small" }, "Email me the result:"),
        select(["never", "auto", "always"], form.email, (v) => (form.email = v)),
      ),
      h("div", { class: "card-actions" }, h("button", { class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: save }, existing ? "Save" : "Create")),
    ];
  });
}

async function showRuns(a) {
  const runs = await guard(rpc("automation.runs", { id: a.id, limit: 25 }));
  modal((close) => [
    h("h3", {}, `History · ${a.name}`),
    runs.length
      ? h(
          "div",
          { class: "list" },
          runs.map((r) =>
            h(
              "div",
              { class: "card", style: { boxShadow: "none" } },
              h("div", { class: "row" }, h("b", {}, fmtTime(r.startedAt)), statusBadge(r.status), h("span", { class: "muted small" }, r.trigger), h("span", { style: { flex: 1 } }), r.sessionId ? h("button", { class: "btn sm", onclick: () => (close(), openSessionFn(r.sessionId)) }, "Open") : null),
              r.summary || r.error ? h("div", { class: "summary-box" }, r.error ?? r.summary) : null,
            ),
          ),
        )
      : h("div", { class: "empty" }, "No runs yet."),
    h("div", { class: "card-actions" }, h("button", { class: "btn", onclick: close }, "Close")),
  ]);
}

// ── Memory ──────────────────────────────────────────────────────────────
export function renderMemory() {
  const fact = h("input", { type: "text", placeholder: "Add something OpenScout should remember…", style: { flex: 1 } });
  const cat = select(["fact", "preference", "decision", "context"], "fact", () => {});
  const add = async () => {
    if (!fact.value.trim()) return;
    await guard(rpc("memory.add", { fact: fact.value.trim(), category: cat.value }));
    fact.value = "";
  };
  fact.addEventListener("keydown", (e) => e.key === "Enter" && add());
  page(
    "memory",
    header("Memory", "Facts and preferences OpenScout keeps across conversations. They're added to every new conversation as context."),
    h("div", { class: "card section" }, h("div", { class: "row" }, fact, cat, h("button", { class: "btn primary", onclick: add }, "Add"))),
    h(
      "div",
      { class: "list" },
      state.memory.length
        ? state.memory.map((m) =>
            h(
              "div",
              { class: "card row", style: { padding: "10px 14px" } },
              h("span", { class: "badge accent" }, m.category),
              h("span", { style: { flex: 1 } }, m.fact),
              h("span", { class: "muted small", title: m.createdAt }, `${m.source === "agent" ? "learned" : "added"} ${fmtRelative(m.createdAt)}`),
              h("button", { class: "icon-btn", title: "Forget", onclick: () => guard(rpc("memory.delete", { id: m.id })) }, "🗑"),
            ),
          )
        : h("div", { class: "empty" }, "Nothing remembered yet. OpenScout saves useful facts as you chat, or add your own above."),
    ),
  );
}

// ── Skills ──────────────────────────────────────────────────────────────
const SOURCE_LABEL = { openscout: "OpenScout", scout: "Microsoft Scout", "copilot-cli": "Copilot CLI" };

export function renderSkills() {
  const src = state.settings.skillSources;
  page(
    "skills",
    header(
      "Skills",
      "Reusable instruction sets. OpenScout loads a skill when your request matches it, or when you type /skill-name.",
      h("button", { class: "btn primary", onclick: () => editSkill(null) }, "＋ New skill"),
    ),
    h(
      "div",
      { class: "card section" },
      h("div", { class: "item-title" }, "Skill sources"),
      h("div", { class: "row" }, switchEl(src.scout, (v) => saveSettings({ skillSources: { scout: v } }), "Load my Microsoft Scout skills (~/.scout/m-skills)")),
      h("div", { class: "row" }, switchEl(src.copilotCli, (v) => saveSettings({ skillSources: { copilotCli: v } }), "Load my GitHub Copilot CLI skills (~/.copilot/skills)")),
    ),
    h(
      "div",
      { class: "list" },
      state.skills.length
        ? state.skills.map((s) =>
            h(
              "div",
              { class: "card" },
              h(
                "div",
                { class: "row" },
                h("div", { style: { flex: 1, minWidth: "240px" } }, h("div", { class: "item-title" }, `/${s.name} `, h("span", { class: "badge" }, SOURCE_LABEL[s.source] ?? s.source)), h("div", { class: "muted small clamp", title: s.description }, s.description)),
                switchEl(s.enabled, (v) => guard(rpc("skill.toggle", { name: s.name, enabled: v }))),
              ),
              h(
                "div",
                { class: "card-actions", style: { justifyContent: "flex-start" } },
                s.editable ? h("button", { class: "btn sm", onclick: () => editSkill(s) }, "Edit") : h("button", { class: "btn sm", onclick: () => viewSkill(s) }, "View"),
                h("button", { class: "btn sm", onclick: () => guard(rpc("os.openPath", { path: s.dir })) }, "Open folder"),
                s.editable
                  ? h(
                      "button",
                      {
                        class: "btn sm danger",
                        onclick: async () => {
                          if (await confirmDialog("Delete skill?", `/${s.name} will be removed from disk.`)) await guard(rpc("skill.delete", { name: s.name }));
                        },
                      },
                      "Delete",
                    )
                  : null,
              ),
            ),
          )
        : h("div", { class: "empty" }, "No skills yet. Ask OpenScout to “make a skill that…”, or create one here."),
    ),
  );
}

async function viewSkill(s) {
  const full = await guard(rpc("skill.get", { name: s.name }));
  modal((close) => [h("h3", {}, `/${s.name}`), h("pre", { class: "summary-box", style: { maxHeight: "60vh" } }, full?.content ?? ""), h("div", { class: "card-actions" }, h("button", { class: "btn", onclick: close }, "Close"))]);
}

async function editSkill(s) {
  let body = "";
  if (s) {
    const full = await guard(rpc("skill.get", { name: s.name }));
    body = (full?.content ?? "").replace(/^---[\s\S]*?---\s*/, "");
  }
  const form = { name: s?.name ?? "", description: s?.description ?? "", instructions: body };
  modal((close) => [
    h("h3", {}, s ? `Edit /${s.name}` : "New skill"),
    h("div", { class: "field" }, h("label", {}, "Name"), h("input", { type: "text", value: form.name, disabled: Boolean(s), placeholder: "weekly-report", oninput: (e) => (form.name = e.target.value) }), h("div", { class: "help" }, "Lowercase letters, numbers and hyphens. Invoke with /name.")),
    h("div", { class: "field" }, h("label", {}, "When to use it"), h("input", { type: "text", value: form.description, placeholder: "Draft my weekly status report from this week's email and meetings", oninput: (e) => (form.description = e.target.value) })),
    h("div", { class: "field" }, h("label", {}, "Instructions (Markdown)"), h("textarea", { rows: 12, value: form.instructions, oninput: (e) => (form.instructions = e.target.value) })),
    h(
      "div",
      { class: "card-actions" },
      h("button", { class: "btn", onclick: close }, "Cancel"),
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            try {
              await rpc("skill.save", form);
              close();
            } catch (err) {
              toast("Couldn't save skill", err.message, { error: true });
            }
          },
        },
        "Save",
      ),
    ),
  ]);
}

// ── Settings ────────────────────────────────────────────────────────────
export async function saveSettings(patch) {
  state.settings = await guard(rpc("settings.update", { patch }), "Couldn't save settings");
  return state.settings;
}

function githubCard() {
  const g = state.github ?? {};
  const ok = g.state === "signed-in";
  const tokenInput = h("input", { type: "password", placeholder: "github_pat_… (fine-grained, with “Copilot Requests” permission)", style: { flex: 1, minWidth: "260px" } });
  return h(
    "div",
    { class: "card section" },
    h("div", { class: "row" }, h("div", { style: { flex: 1 } }, h("div", { class: "item-title" }, "GitHub Copilot"), h("div", { class: "muted small" }, "Provides the AI models. Uses your own GitHub Copilot subscription.")), h("span", { class: `badge ${ok ? "ok" : "err"}` }, ok ? `Signed in as ${g.login}` : g.state === "starting" ? "Starting…" : "Not signed in")),
    g.message && !ok ? h("div", { class: "muted small" }, g.message) : null,
    h(
      "div",
      { class: "card-actions", style: { justifyContent: "flex-start" } },
      h("button", { class: "btn sm", onclick: () => guard(rpc("github.refresh")) }, "Refresh"),
      g.cliLoginAvailable ? h("button", { class: "btn sm", onclick: () => guard(rpc("github.importCli")) }, "Use my Copilot CLI sign-in") : null,
      h(
        "button",
        {
          class: "btn sm",
          onclick: async () => {
            const r = await guard(rpc("github.openLogin"));
            toast("GitHub sign-in", r.instructions, { timeout: 15000 });
          },
        },
        "Sign in with GitHub…",
      ),
      h("button", { class: "btn sm", onclick: () => guard(rpc("github.importCli")) }, "I've signed in"),
    ),
    h("details", {}, h("summary", { class: "muted small" }, "Use a GitHub token instead"), h("div", { class: "row", style: { marginTop: "8px" } }, tokenInput, h("button", { class: "btn sm", onclick: () => tokenInput.value && guard(rpc("github.token", { token: tokenInput.value })).then(() => (tokenInput.value = "")) }, "Save token"))),
  );
}

function m365Card() {
  const st = state.m365 ?? {};
  const s = state.settings.m365;
  const graph = s.provider !== "workiq";
  const stateLabel =
    {
      ready: ["ok", `Connected as ${st.user?.displayName ?? st.user?.mail ?? "you"}`],
      starting: ["warn", "Connecting…"],
      "signing-in": ["warn", "Waiting for sign-in…"],
      "signed-out": ["err", "Sign-in needed"],
      eula: ["warn", "Accept the Work IQ terms"],
      error: ["err", "Error"],
      missing: ["err", "Work IQ CLI missing"],
      disabled: ["", "Off"],
    }[st.state] ?? ["", st.state ?? "…"];
  const providers = [
    ["graph", "Direct sign-in (recommended)", "Sign in with any Microsoft 365 work or school account. No Microsoft 365 Copilot licence needed."],
    ["workiq", "Work IQ", "Use the Work IQ CLI. Needs your tenant to approve Work IQ; its ask/retrieve tools need a Microsoft 365 Copilot licence."],
  ];
  const signIn = () => {
    toast("Microsoft 365 sign-in", graph ? "Finish signing in in the browser window that opens." : "Complete the sign-in in the window that opens.", { timeout: 12000 });
    guard(rpc("m365.signIn")).then((r) => r?.state === "ready" && toast("Signed in to Microsoft 365", r.user?.mail ?? ""));
  };

  const clientId = h("input", { type: "text", value: s.clientId, placeholder: "Application (client) ID", style: { flex: 1, minWidth: "260px" } });
  const tenant = h("input", { type: "text", value: s.tenant, placeholder: "organizations, tenant ID or contoso.edu", style: { width: "240px" } });
  const graphOptions = graph
    ? h(
        "div",
        {},
        h(
          "details",
          { style: { marginTop: "10px" }, open: Boolean(s.clientId) },
          h("summary", { class: "muted small" }, `Sign-in app: ${st.signInApp ?? "Microsoft Graph Command Line Tools"}`),
          h(
            "div",
            { class: "help", style: { margin: "6px 0" } },
            "By default OpenScout signs in with Microsoft's public Microsoft Graph Command Line Tools client. Schools and organisations can register their own app (public client, redirect URI http://localhost) and enter its client ID here.",
          ),
          h(
            "div",
            { class: "row" },
            clientId,
            tenant,
            h("button", { class: "btn sm", onclick: () => saveSettings({ m365: { clientId: clientId.value.trim(), tenant: tenant.value.trim() || "organizations" } }) }, "Save"),
            s.clientId ? h("button", { class: "btn sm", onclick: () => saveSettings({ m365: { clientId: "", tenant: "organizations" } }) }, "Use default") : null,
          ),
        ),
        h(
          "div",
          { class: "field", style: { marginTop: "10px" } },
          h("label", {}, "Optional permissions (need an administrator to approve)"),
          (st.scopeGroups ?? []).map((g) =>
            switchEl(g.enabled, (v) => saveSettings({ m365: { scopeGroups: v ? [...s.scopeGroups, g.id] : s.scopeGroups.filter((x) => x !== g.id) } }), g.label),
          ),
          h("div", { class: "help" }, "Turning one on asks you to sign in again. If your organisation hasn't approved it, the sign-in will say an administrator must approve."),
        ),
      )
    : h(
        "div",
        {},
        st.state === "eula"
          ? h(
              "div",
              { class: "card", style: { boxShadow: "none", margin: "8px 0" } },
              h("div", {}, "Work IQ requires accepting the Microsoft Work IQ CLI Pre-Release/Evaluation Use Terms: ", h("a", { href: "https://github.com/microsoft/work-iq/tree/main/EULA", target: "_blank", rel: "noopener" }, "read the terms"), "."),
              h("div", { class: "card-actions", style: { justifyContent: "flex-start" } }, h("button", { class: "btn primary sm", onclick: () => guard(rpc("workiq.acceptEula")) }, "I accept the terms")),
            )
          : null,
        h(
          "div",
          { class: "field", style: { marginTop: "12px" } },
          switchEl(s.copilotLicense, (v) => saveSettings({ m365: { copilotLicense: v } }), "I have a Microsoft 365 Copilot licence"),
          h("div", { class: "help" }, "Optional. Unlocks Work IQ's natural-language ask and semantic retrieve tools, which call the Microsoft 365 Copilot APIs. Everything else works without it."),
        ),
      );

  return h(
    "div",
    { class: "card section" },
    h(
      "div",
      { class: "row" },
      h("div", { style: { flex: 1 } }, h("div", { class: "item-title" }, "Microsoft 365"), h("div", { class: "muted small" }, "Mail, calendar, Teams, OneDrive/SharePoint and people through Microsoft Graph, using your own sign-in.")),
      h("span", { class: `badge ${stateLabel[0]}` }, stateLabel[1]),
      switchEl(s.enabled, (v) => saveSettings({ m365: { enabled: v } })),
    ),
    st.user?.mail ? h("div", { class: "muted small" }, `${st.user.mail}${st.user.jobTitle ? ` · ${st.user.jobTitle}` : ""}`) : null,
    st.message && st.state !== "ready" ? h("pre", { class: "summary-box" }, st.message) : null,
    h(
      "div",
      { class: "radio-cards", style: { marginTop: "10px" } },
      providers.map(([id, name, desc]) =>
        h("div", { class: `radio-card${s.provider === id ? " sel" : ""}`, onclick: () => s.provider !== id && saveSettings({ m365: { provider: id } }).then(renderSettings) }, h("b", {}, name), h("span", {}, desc)),
      ),
    ),
    h(
      "div",
      { class: "card-actions", style: { justifyContent: "flex-start" } },
      h("button", { class: `btn sm${st.state === "signed-out" ? " primary" : ""}`, onclick: signIn, disabled: st.state === "signing-in" || !s.enabled }, st.state === "ready" ? "Switch account…" : "Sign in…"),
      st.state === "ready" ? h("button", { class: "btn sm", onclick: () => guard(rpc("m365.signOut")) }, "Sign out") : null,
      h("button", { class: "btn sm", onclick: () => guard(rpc("m365.refresh")) }, "Refresh"),
    ),
    graphOptions,
    st.tools?.length ? h("details", {}, h("summary", { class: "muted small" }, `${st.tools.length} Microsoft 365 tools available`), h("div", { class: "muted small" }, st.tools.join(", "))) : null,
  );
}

export function renderSettings() {
  const s = state.settings;
  const modelOpts = [{ value: "auto", label: "Auto (let Copilot choose)" }, ...state.models.filter((m) => m.id !== "auto").map((m) => ({ value: m.id, label: `${m.name}${m.multiplier !== undefined && m.multiplier !== 1 ? ` · ${m.multiplier}×` : ""}` }))];
  const modes = [
    ["ask", "Ask every time", "Approve each command, file edit and Microsoft 365 change."],
    ["auto-read", "Auto-approve reads", "Recommended. Reading is automatic; changes and sends need your OK."],
    ["allow-all", "Allow everything", "Never ask. Only for trusted, supervised use."],
  ];
  const shellAllow = h("textarea", { rows: 4, value: s.permissions.shellAllow.join("\n"), onchange: (e) => saveSettings({ permissions: { shellAllow: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) } }) });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  page(
    "settings",
    header("Settings", `OpenScout ${state.app?.version ?? ""} · data in ${state.app?.dataDir ?? "~/.openscout"}`),
    h("div", { class: "section" }, h("h2", {}, "Accounts"), githubCard(), m365Card()),
    h(
      "div",
      { class: "section card" },
      h("h2", {}, "Model & personality"),
      h("div", { class: "field" }, h("label", {}, "Default model for new conversations"), select(modelOpts, s.defaultModel, (v) => saveSettings({ defaultModel: v })), h("div", { class: "row" }, h("button", { class: "btn sm", onclick: () => guard(rpc("models.refresh")) }, "Refresh model list"))),
      h("div", { class: "field" }, h("label", {}, "Reasoning effort"), select([{ value: "", label: "Model default" }, "low", "medium", "high", "xhigh"].map((x) => (typeof x === "string" ? { value: x, label: x } : x)), s.reasoningEffort, (v) => saveSettings({ reasoningEffort: v })), h("div", { class: "help" }, "Applied only to models that support it.")),
      h(
        "div",
        { class: "field" },
        h("label", {}, "Personality"),
        h("div", { class: "radio-cards" }, state.personalities.map((p) => h("div", { class: `radio-card${p.id === s.personality ? " sel" : ""}`, onclick: () => saveSettings({ personality: p.id }).then(renderSettings) }, h("b", {}, p.name), h("span", {}, p.description)))),
      ),
      h(
        "div",
        { class: "field" },
        h("label", {}, "I'm using OpenScout for"),
        h(
          "div",
          { class: "radio-cards" },
          [
            ["work", "Work", "Suggestions and guidance for work tasks."],
            ["student", "Study", "Student suggestions, study help and academic-integrity guidance."],
          ].map(([id, name, desc]) => h("div", { class: `radio-card${(s.audience ?? "work") === id ? " sel" : ""}`, onclick: () => saveSettings({ audience: id }).then(renderSettings) }, h("b", {}, name), h("span", {}, desc))),
        ),
      ),
    ),
    h(
      "div",
      { class: "section card" },
      h("h2", {}, "Permissions"),
      h("div", { class: "radio-cards" }, modes.map(([id, name, desc]) => h("div", { class: `radio-card${s.permissions.mode === id ? " sel" : ""}`, onclick: () => saveSettings({ permissions: { mode: id } }).then(renderSettings) }, h("b", {}, name), h("span", {}, desc)))),
      h("div", { class: "field", style: { marginTop: "12px" } }, h("label", {}, "Always-allowed shell commands"), shellAllow, h("div", { class: "help" }, "One command prefix per line, e.g. Get-ChildItem. Commands that write via redirection still ask.")),
      h("div", { class: "help" }, "Changes to Microsoft 365 (sending mail, posting, accepting meetings, editing items) always ask unless you choose “Allow everything”."),
    ),
    h(
      "div",
      { class: "section card" },
      h("h2", {}, "Tools"),
      h("div", { class: "row" }, switchEl(s.browser.enabled, (v) => saveSettings({ browser: { enabled: v } }), "Browser automation (Playwright)"), select(["msedge", "chrome", "chromium"], s.browser.channel, (v) => saveSettings({ browser: { channel: v } })), switchEl(s.browser.headless, (v) => saveSettings({ browser: { headless: v } }), "Headless")),
      h("div", { class: "row" }, switchEl(s.github.mcpEnabled, (v) => saveSettings({ github: { mcpEnabled: v } }), "GitHub tools (issues, PRs, code search)")),
      h("div", { class: "help" }, "Tool changes apply to new conversations."),
    ),
    h(
      "div",
      { class: "section card" },
      h("h2", {}, "Notifications & work hours"),
      h("div", { class: "row" }, switchEl(s.notifications.desktop, (v) => saveSettings({ notifications: { desktop: v } }), "Desktop notifications")),
      h("div", { class: "row" }, switchEl(s.notifications.email, (v) => saveSettings({ notifications: { email: v } }), "Allow emailing results to myself (via Microsoft 365)")),
      h(
        "div",
        { class: "row" },
        h("span", { class: "muted small" }, "Work hours"),
        h("input", { type: "time", value: s.workHours.start, onchange: (e) => saveSettings({ workHours: { start: e.target.value } }) }),
        h("span", { class: "muted small" }, "to"),
        h("input", { type: "time", value: s.workHours.end, onchange: (e) => saveSettings({ workHours: { end: e.target.value } }) }),
        days.map((d, i) =>
          h(
            "label",
            { class: "small" },
            h("input", {
              type: "checkbox",
              checked: s.workHours.days.includes(i),
              onchange: (e) => saveSettings({ workHours: { days: e.target.checked ? [...new Set([...s.workHours.days, i])].sort() : s.workHours.days.filter((x) => x !== i) } }),
            }),
            ` ${d}`,
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "section card" },
      h("h2", {}, "App"),
      h("div", { class: "row" }, h("span", { class: "muted small" }, "Theme"), select(["system", "light", "dark"], s.theme, (v) => saveSettings({ theme: v }))),
      state.app?.host === "electron"
        ? h(
            "div",
            {},
            h("div", { class: "row" }, switchEl(s.shortcut.enabled, (v) => saveSettings({ shortcut: { enabled: v } }), "Global show/hide shortcut"), h("input", { type: "text", value: s.shortcut.accelerator, style: { width: "180px" }, onchange: (e) => saveSettings({ shortcut: { accelerator: e.target.value.trim() } }) })),
            h("div", { class: "row" }, switchEl(s.closeToTray, (v) => saveSettings({ closeToTray: v }), "Keep running in the tray when the window is closed (automations keep working)")),
          )
        : null,
      h(
        "div",
        { class: "field", style: { marginTop: "12px" } },
        h("label", {}, "Working folder"),
        h("div", { class: "row" }, h("input", { type: "text", value: s.workingDirectory, style: { flex: 1 }, onchange: (e) => saveSettings({ workingDirectory: e.target.value.trim() }) }), h("button", { class: "btn sm", onclick: () => guard(rpc("os.openWorkingFolder")) }, "Open")),
        h("div", { class: "help" }, "Where OpenScout saves files it creates. Applies to new conversations."),
      ),
      h("div", { class: "row" }, h("span", { class: "muted small" }, "Delete conversations older than"), h("input", { type: "number", min: 0, value: s.sessionRetentionDays, style: { width: "90px" }, onchange: (e) => saveSettings({ sessionRetentionDays: Number(e.target.value) }) }), h("span", { class: "muted small" }, "days (0 = keep forever)"), h("span", { style: { flex: 1 } }), h("button", { class: "btn sm", onclick: () => guard(rpc("os.openDataFolder")) }, "Open data folder")),
    ),
  );
}
