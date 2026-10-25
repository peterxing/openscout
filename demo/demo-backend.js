// OpenScout browser demo: a simulated backend so the real UI can run on a static website.
// Everything here is fictional Contoso sample data. No network, AI or Microsoft 365 calls are made.
import { describeSchedule, nextRun, parseSchedule } from "./schedule.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d = new Date()) => d.toISOString();
const rid = (p) => `${p}${Math.random().toString(36).slice(2, 10)}`;
const WORK_HOURS = { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const TOKEN_LIMIT = 272000;
const NOT_IN_DEMO = "That needs the desktop app — it isn't available in the browser demo.";

const USER = { displayName: "Alex Morgan", mail: "alex.morgan@contoso.com", userPrincipalName: "alex.morgan@contoso.com", jobTitle: "Product Manager" };

const MODELS = [
  { id: "auto", name: "Auto", vision: true, reasoning: false, contextTokens: 0 },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", multiplier: 1, vision: true, reasoning: true, contextTokens: 1000000 },
  { id: "gpt-6-sol", name: "GPT-6 Sol", multiplier: 1, vision: true, reasoning: true, contextTokens: 1000000 },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", multiplier: 0.33, vision: true, reasoning: false, contextTokens: 1000000 },
];

const PERSONALITIES = [
  { id: "balanced", name: "Balanced", description: "Warm, clear and efficient." },
  { id: "concise", name: "Concise", description: "Minimal words, maximum signal." },
  { id: "coach", name: "Coach", description: "Proactive, suggests next steps." },
  { id: "formal", name: "Formal", description: "Polished, executive-ready tone." },
];

const M365_TOOLS = ["m365_fetch", "m365_fetch_file", "m365_create", "m365_update", "m365_delete", "m365_action", "m365_function", "m365_get_schema", "m365_search_paths"];

function defaultSettings() {
  return {
    theme: "system",
    defaultModel: "auto",
    reasoningEffort: "",
    personality: "balanced",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDirectory: "C:\\Users\\alex\\Documents\\OpenScout",
    permissions: { mode: "auto-read", shellAllow: ["Get-ChildItem", "Get-Content", "Get-Date", "Test-Path"] },
    m365: { enabled: true, copilotLicense: false, account: "" },
    browser: { enabled: true, channel: "msedge", headless: false },
    github: { mcpEnabled: true },
    notifications: { desktop: true, email: true },
    heartbeat: {
      enabled: false,
      intervalMinutes: 60,
      schedule: "work-hours",
      prompt: "Check unread email, my next 3 hours of meetings and Teams mentions. Only surface what needs attention soon; otherwise reply [[quiet]].",
      emailNotify: "never",
    },
    workHours: { ...WORK_HOURS },
    shortcut: { enabled: true, accelerator: "Control+Alt+O" },
    closeToTray: true,
    sessionRetentionDays: 365,
    skillSources: { scout: false, copilotCli: true },
    disabledSkills: [],
  };
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
  return out;
}

function at(h, m, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (d) => d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
const fmtStamp = (d = new Date()) => d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function makeTitle(prompt) {
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "New conversation";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

// ── Scenario content ────────────────────────────────────────────────────────

const tool = (name, args, result, extra = {}) => ({ type: "tool", name, args, result, ...extra });
const say = (text) => ({ type: "say", text });
const think = (text) => ({ type: "think", text });
const intent = (text) => ({ type: "intent", text });

function calendarAnswer() {
  const t = (h, m) => fmtTime(at(h, m));
  return [
    `### ${fmtDay(new Date())}`,
    "",
    "| Time | Meeting | Notes |",
    "| --- | --- | --- |",
    `| ${t(9, 30)}–${t(10, 0)} | Product sync | Standing agenda, Teams |`,
    `| ${t(11, 0)}–${t(11, 45)} | **Fabrikam renewal call** | Dana Whitfield (CFO) + procurement |`,
    `| ${t(11, 30)}–${t(12, 15)} | Design review: onboarding v2 | ⚠️ Overlaps the Fabrikam call |`,
    `| ${t(14, 0)}–${t(14, 30)} | 1:1 with Jordan Lee | Bring the Q3 roadmap update |`,
    `| ${t(15, 30)}–${t(17, 0)} | Focus time | |`,
    "",
    "**Conflict:** the design review overlaps the Fabrikam call by 15 minutes. Want me to propose a new time to Sam Lee?",
    "",
    "**Prep:**",
    "- Skim *Fabrikam Renewal Proposal.docx* (updated yesterday) and Priya's pricing email from Tuesday.",
    "- Jordan asked for the Q3 roadmap slide — it's in *Contoso Q3 Planning.pptx*, slide 7.",
  ].join("\n");
}

const INBOX_ANSWER = [
  "**Unread in the last 24 hours: 6** — 2 need a reply",
  "",
  "1. **Priya Shah — “Q3 budget sign-off needed by Friday”** · needs your approval on the revised model. *Reply needed*",
  "2. **Dana Whitfield (Fabrikam) — “Renewal: multi-year pricing?”** · wants options before today's call. *Reply needed*",
  "3. Sam Lee — “Design review moved?” · FYI, superseded by the calendar update.",
  "4. IT Communications — “Planned maintenance Saturday” · FYI.",
  "5. Contoso Weekly — newsletter · no action.",
  "6. Jordan Lee — “Great job on the launch” · a quick thanks would be nice.",
  "",
  "Want me to draft replies to Priya and Dana?",
].join("\n");

const TEAMS_ANSWER = [
  "**Teams today — 3 things for you**",
  "",
  "- **#launch-planning** — Sam Lee mentioned you: *“can you confirm the beta date is still the 14th?”* (10:12)",
  "- **Chat with Priya Shah** — asked whether the budget model needs a contingency line (9:41)",
  "- **Fabrikam account team** — the redlined contract was shared in Files (8:55)",
  "",
  "The beta-date question is the only one blocking someone.",
].join("\n");

const FILES_ANSWER = [
  "Your most recently edited decks:",
  "",
  "| Deck | Last edited | Location |",
  "| --- | --- | --- |",
  "| Contoso Q3 Planning.pptx | yesterday | OneDrive › Planning |",
  "| Fabrikam Renewal Proposal.pptx | 2 days ago | Sales › Fabrikam |",
  "| Launch Readiness Review.pptx | last week | Product › Launch |",
  "",
  "Want a five-bullet summary of any of them?",
].join("\n");

const DIAGRAM_ANSWER = [
  "Here's how OpenScout fits together:",
  "",
  "```mermaid",
  "flowchart LR",
  "  UI[Desktop UI] -->|WebSocket + token| BE[Local backend]",
  "  BE --> SDK[GitHub Copilot SDK] --> M[(Copilot models)]",
  "  BE --> WIQ[Work IQ MCP] --> G[(Microsoft Graph)]",
  "  SDK --> PW[Playwright MCP] --> E[Microsoft Edge]",
  "```",
  "",
  "Everything runs on your PC; the only cloud calls are to GitHub Copilot and Microsoft Graph with your own sign-in.",
].join("\n");

const CAPABILITIES_ANSWER = [
  "I'm OpenScout — a desktop work assistant. In the real app I can:",
  "",
  "- **Microsoft 365** (through Work IQ): search and read your mail, calendar, Teams chats, OneDrive/SharePoint files and people; draft and — with your approval — send replies, accept meetings or create events.",
  "- **Your PC**: run commands, read and edit files, and drive a browser for sites that need sign-in.",
  "- **The web**: search and summarise pages.",
  "- **Automations**: run prompts on a schedule (“every weekday at 8am”) or when something happens, and notify you.",
  "- **Memory & skills**: remember your preferences and follow reusable playbooks like `/weekly-report`.",
  "",
  "Anything that changes data or sends something on your behalf asks for your OK first. Try one of the scenarios on the home screen!",
].join("\n");

const DEFAULT_ANSWER = [
  "This is the **browser demo** of OpenScout, so I can only play back a few scripted scenarios with fictional Contoso data — no AI model or Microsoft 365 account is connected.",
  "",
  "Try asking about:",
  "- your **calendar** today, **unread email** or **Teams** mentions",
  "- **finding a deck**, or **replying** to someone (you'll see an approval prompt)",
  "- **creating an automation** (“every weekday at 8am…”), **remembering** a preference, or a **diagram**",
  "",
  "To use OpenScout for real, install it from GitHub — it runs on your own GitHub Copilot subscription and your Work IQ access.",
].join("\n");

function scenarioFor(prompt, server) {
  const q = prompt.toLowerCase();

  if (/^\s*remember\b/.test(q) || /\bremember that\b/.test(q)) {
    const fact = prompt.replace(/^\s*(please\s+)?remember( that)?\s*/i, "").trim() || prompt.trim();
    return [
      tool("memory_remember", { fact, category: "preference" }, "Saved to memory."),
      { type: "effect", run: () => server.addMemory(fact, "preference", "agent") },
      say(`Got it — I'll remember that: *${fact}*. You can review it under **Memory**.`),
    ];
  }

  if (/\b(automation|every (week)?day|weekdays?|every (mon|tue|wed|thu|fri)|remind|briefing|each morning)\b/.test(q)) {
    let schedule = "every weekday at 8am";
    try {
      parseSchedule(prompt);
      const m = /\b(every[^,.]*?\b(?:at|during)\b[^,.]*?(?:am|pm|\d{2}:\d{2}|hours))/i.exec(prompt);
      schedule = m ? m[1].trim() : prompt;
      parseSchedule(schedule);
    } catch {
      schedule = "every weekday at 8am";
    }
    const name = /brief/.test(q) ? "Morning briefing" : /wrap|friday/.test(q) ? "Friday wrap-up" : "New automation";
    const automationPrompt = /brief/.test(q)
      ? "Brief me on today's meetings, urgent unread email and Teams mentions. Keep it to a short bulleted list."
      : prompt.trim();
    return [
      intent("Setting up the automation"),
      tool("automation_create", { name, schedule, prompt: automationPrompt, desktopNotify: true }, `Saved automation "${name}".`),
      {
        type: "effect",
        run: () => server.upsertAutomation({ name, schedule, prompt: automationPrompt, notify: { desktop: true, email: "never" } }),
      },
      { type: "say-dynamic", text: () => server.automationCreatedText(name) },
    ];
  }

  if (/\b(unread|inbox)\b/.test(q) || (/\bemails?\b/.test(q) && /\b(summari[sz]e|triage|catch me up)\b/.test(q))) {
    return [
      intent("Checking your inbox"),
      think("The user wants unread mail from the last day. I'll fetch unread inbox messages with a small $select, then group them by whether they need a reply."),
      tool(
        "m365_fetch",
        { entityUrls: ["/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=10&$select=subject,from,receivedDateTime,bodyPreview"] },
        '{"results":[{"statusCode":200,"data":{"value":[{"subject":"Q3 budget sign-off needed by Friday","from":{"emailAddress":{"name":"Priya Shah"}}},{"subject":"Renewal: multi-year pricing?","from":{"emailAddress":{"name":"Dana Whitfield"}}},"… 4 more"]}}]}',
      ),
      say(INBOX_ANSWER),
    ];
  }

  if (/\b(reply|respond|send|draft)\b/.test(q) && /\b(email|mail|priya|dana|jordan|sam|message)\b/.test(q)) {
    const to = /dana/.test(q) ? { name: "Dana Whitfield", address: "dana.whitfield@fabrikam.com" } : { name: "Priya Shah", address: "priya.shah@contoso.com" };
    const body =
      to.name === "Priya Shah"
        ? "Hi Priya, thanks for the revised model. I'll review it and confirm sign-off by Thursday. Alex"
        : "Hi Dana, thanks for raising multi-year pricing. I'll bring two options to today's call. Alex";
    return [
      say(`Here's a draft to **${to.name}**:\n\n> ${body}\n\nI'll send it once you approve.`),
      {
        type: "permission",
        summary: {
          kind: "m365",
          permissionKind: "m365",
          title: "Send an email",
          detail: `POST /me/sendMail\n\n${JSON.stringify({ message: { subject: "Re: your note", toRecipients: [{ emailAddress: to }], body: { contentType: "Text", content: body } } }, null, 2)}`,
          readOnly: false,
          risk: "high",
          allowSession: false,
          toolName: "m365_action",
        },
        onAllow: [
          tool("m365_action", { actionUrl: "/me/sendMail", jsonBody: { message: { toRecipients: [{ emailAddress: to }] } } }, "202 Accepted (demo — nothing was actually sent)"),
          say(`Sent to ${to.name}. *(In this demo nothing leaves your browser.)*`),
        ],
        onDeny: [say("No problem — I didn't send it. Want me to save it as a draft in Outlook instead?")],
      },
    ];
  }

  if (/\b(teams|chats?|mention(ed|s)?|channel)\b/.test(q)) {
    return [
      intent("Catching up on Teams"),
      tool("m365_search", { query: "Alex Morgan", entityTypes: ["chatMessage"], size: 10 }, "### Teams messages (chatMessage) — 7 matches, showing 1–7\n1. **Sam Lee** · #launch-planning …"),
      say(TEAMS_ANSWER),
    ];
  }

  if (/\b(ask me|choose|pick|which one)\b/.test(q)) {
    return [
      {
        type: "input",
        question: "Which deck should I summarise?",
        choices: ["Contoso Q3 Planning.pptx", "Fabrikam Renewal Proposal.pptx", "Launch Readiness Review.pptx"],
        then: (answer) => [
          tool("m365_fetch_file", { path: "/drives/demo/items/demo/content", format: "pdf" }, `Saved 2,481,233 bytes (application/pdf) to C:\\Users\\alex\\Documents\\OpenScout\\Downloads\\${answer.replace(/\.pptx$/, "")}.pdf`),
          say(`**${answer}** in five bullets:\n\n- Q3 goal: grow active teams 25% through the onboarding v2 launch\n- Two bets: self-serve trials and a partner channel pilot\n- Budget: flat headcount, +12% marketing for the launch window\n- Risks: beta slipping past the 14th; Fabrikam renewal timing\n- Ask: decision on the partner pilot by the end of the month`),
        ],
      },
    ];
  }

  if (/\b(calendar|meetings?|schedule|today|agenda)\b/.test(q)) {
    return [
      intent("Reading your calendar"),
      tool(
        "m365_fetch",
        { entityUrls: [`/me/calendarView?startDateTime=${iso(at(0, 0))}&endDateTime=${iso(at(23, 59))}&$select=subject,start,end,attendees`] },
        '{"results":[{"statusCode":200,"data":{"value":["Product sync","Fabrikam renewal call","Design review: onboarding v2","1:1 with Jordan Lee","Focus time"]}}]}',
      ),
      tool("m365_search", { query: "Fabrikam renewal", entityTypes: ["message", "driveItem"], size: 5 }, "### Emails (message) — 4 matches\n1. **Renewal: multi-year pricing?** — Dana Whitfield\n### Files (driveItem) — 2 matches\n1. **Fabrikam Renewal Proposal.docx**"),
      say(calendarAnswer()),
    ];
  }

  if (/\b(decks?|pptx?|powerpoint|files?|documents?|slides?|presentation)\b/.test(q)) {
    return [
      intent("Searching your files"),
      tool("m365_search", { query: "filetype:pptx", entityTypes: ["driveItem"], size: 5 }, "### Files (driveItem) — 23 matches, showing 1–5\n1. **Contoso Q3 Planning.pptx** — modified yesterday\n2. **Fabrikam Renewal Proposal.pptx**\n3. **Launch Readiness Review.pptx**"),
      say(FILES_ANSWER),
    ];
  }

  if (/\b(diagram|mermaid|flowchart|architecture|how (does|do) (it|you) work)\b/.test(q)) return [say(DIAGRAM_ANSWER)];

  if (/\b(what can you do|capabilit|help|tour|who are you)\b/.test(q)) return [say(CAPABILITIES_ANSWER)];

  return [say(DEFAULT_ANSWER)];
}

// ── Seed data ───────────────────────────────────────────────────────────────

function seedSessions() {
  const sessions = [];
  const add = (meta, transcript) => sessions.push({ meta: { titleSource: "user", model: "auto", origin: "chat", ...meta }, transcript, busy: false });
  const morning = at(8, 0);
  add(
    { id: crypto.randomUUID(), title: "Prep me for the Fabrikam renewal call", createdAt: iso(new Date(Date.now() - 2 * 3600e3)), updatedAt: iso(new Date(Date.now() - 2 * 3600e3)), usage: { currentTokens: 31200, tokenLimit: TOKEN_LIMIT } },
    [
      { t: iso(), kind: "user", text: "Prep me for the Fabrikam renewal call — who's attending, what's open, and what should I watch out for?" },
      { t: iso(), kind: "tool", toolCallId: rid("call_"), name: "m365_search", args: '{\n  "query": "Fabrikam renewal",\n  "entityTypes": ["message", "event", "driveItem"]\n}', success: true, result: "### Emails (message) — 4 matches …\n### Calendar events (event) — 1 match …\n### Files (driveItem) — 2 matches …" },
      { t: iso(), kind: "tool", toolCallId: rid("call_"), name: "m365_fetch", args: '{\n  "entityUrls": ["/me/events/AAMkADemo?$select=subject,attendees,start,end"]\n}', success: true, result: '{"results":[{"statusCode":200,"data":{"subject":"Fabrikam renewal call","attendees":["Dana Whitfield","Lee Chen","Priya Shah"]}}]}' },
      {
        t: iso(),
        kind: "assistant",
        text: "### Fabrikam renewal — call brief\n\n**Attending:** Dana Whitfield (CFO), Lee Chen (procurement), Priya Shah (our pricing lead).\n\n**Open items**\n- Multi-year discount request (Dana's email, Tuesday)\n- Redlined contract §7 liability cap — legal hasn't responded\n- Usage dropped 8% last quarter in their EMEA teams\n\n**Watch out for:** they'll anchor on the usage dip; lead with the onboarding v2 roadmap.",
      },
    ],
  );
  add(
    { id: crypto.randomUUID(), title: `Morning briefing · ${fmtStamp(morning)}`, origin: "automation", automationName: "Morning briefing", createdAt: iso(morning), updatedAt: iso(morning) },
    [
      { t: iso(morning), kind: "user", text: "Brief me on today's meetings, urgent unread email and Teams mentions. Keep it to a short bulleted list." },
      { t: iso(morning), kind: "tool", toolCallId: rid("call_"), name: "m365_fetch", args: '{\n  "entityUrls": ["/me/calendarView?…"]\n}', success: true, result: "5 events" },
      { t: iso(morning), kind: "tool", toolCallId: rid("call_"), name: "m365_search", args: '{\n  "query": "is:unread importance:high",\n  "entityTypes": ["message"]\n}', success: true, result: "2 matches" },
      { t: iso(morning), kind: "assistant", text: MORNING_BRIEF },
    ],
  );
  const y = new Date(Date.now() - 26 * 3600e3);
  add(
    { id: crypto.randomUUID(), title: "Summarise the Q3 planning deck", createdAt: iso(y), updatedAt: iso(y) },
    [
      { t: iso(y), kind: "user", text: "Summarise the Contoso Q3 Planning deck in five bullets." },
      { t: iso(y), kind: "tool", toolCallId: rid("call_"), name: "m365_search", args: '{\n  "query": "\\"Q3 Planning\\" filetype:pptx",\n  "entityTypes": ["driveItem"]\n}', success: true, result: "1. **Contoso Q3 Planning.pptx** — modified yesterday" },
      { t: iso(y), kind: "tool", toolCallId: rid("call_"), name: "m365_fetch_file", args: '{\n  "path": "/drives/demo/items/demo/content",\n  "format": "pdf"\n}', success: true, result: "Saved 2,481,233 bytes (application/pdf) to C:\\Users\\alex\\Documents\\OpenScout\\Downloads\\Contoso Q3 Planning.pdf" },
      {
        t: iso(y),
        kind: "assistant",
        text: "- Q3 goal: grow active teams 25% through the onboarding v2 launch\n- Two bets: self-serve trials and a partner channel pilot\n- Budget: flat headcount, +12% marketing for the launch window\n- Risks: beta slipping past the 14th; Fabrikam renewal timing\n- Ask: decision on the partner pilot by the end of the month",
      },
    ],
  );
  const d3 = new Date(Date.now() - 3 * 86400e3);
  add(
    { id: crypto.randomUUID(), title: "Draft a reply to Priya about the budget", createdAt: iso(d3), updatedAt: iso(d3) },
    [
      { t: iso(d3), kind: "user", text: "Draft a reply to Priya saying I'll review the budget model by Thursday — don't send it yet." },
      { t: iso(d3), kind: "assistant", text: "Draft:\n\n> Hi Priya, thanks for the revised model. I'll review it and confirm sign-off by Thursday. Alex\n\nI'll save it to your Drafts folder." },
      { t: iso(d3), kind: "permission", title: "Create an email draft", detail: "POST /me/messages", decision: "once" },
      { t: iso(d3), kind: "tool", toolCallId: rid("call_"), name: "m365_create", args: '{\n  "parentUrl": "/me/messages",\n  "jsonBody": { "subject": "Re: Q3 budget sign-off" }\n}', success: true, result: '{"statusCode":201,"data":{"isDraft":true}}' },
      { t: iso(d3), kind: "assistant", text: "Saved as a draft in Outlook — it's in your **Drafts** folder whenever you're ready to send." },
    ],
  );
  return sessions;
}

const MORNING_BRIEF = [
  "**Today**",
  "- 5 meetings; the design review overlaps the **Fabrikam renewal call** (11:00)",
  "- 1:1 with Jordan at 2pm — bring the Q3 roadmap update",
  "",
  "**Needs a reply**",
  "- Priya Shah: Q3 budget sign-off by Friday",
  "- Dana Whitfield (Fabrikam): multi-year pricing options",
  "",
  "**Teams**",
  "- Sam Lee asked you to confirm the beta date in #launch-planning",
].join("\n");

const WRAP_UP = [
  "**Week in review**",
  "- Sent 34 emails; longest thread: Fabrikam renewal (12 messages)",
  "- 14 meetings (9.5 hours); 3 hours of focus time protected",
  "- Shipped: onboarding v2 beta plan; budget model v3 reviewed",
  "",
  "**Carry over**: Fabrikam contract §7, partner pilot decision",
].join("\n");

// ── Simulated server ────────────────────────────────────────────────────────

class DemoServer {
  constructor(deliver) {
    this.deliver = deliver;
    this.settings = defaultSettings();
    this.github = { state: "signed-in", login: "alex-demo", host: "https://github.com", authType: "user", cliLoginAvailable: false };
    this.workiq = { state: "ready", user: USER, serverVersion: "demo", tools: M365_TOOLS, copilotLicense: false };
    this.sessions = new Map(seedSessions().map((s) => [s.meta.id, s]));
    this.turns = new Map();
    this.perms = new Map();
    this.inputs = new Map();
    this.running = new Set();
    this.runs = [];
    this.memory = [
      ["preference", "Alex prefers concise bullet-point summaries with links."],
      ["fact", "Alex's manager is Jordan Lee (VP Product)."],
      ["context", "The Fabrikam renewal is due 30 November; Priya Shah owns the pricing model."],
      ["decision", "Weekly status reports go out on Fridays by 4pm."],
    ].map(([category, fact], i) => ({ id: rid("mem_"), fact, category, source: i % 2 ? "user" : "agent", createdAt: iso(new Date(Date.now() - (i + 1) * 86400e3)) }));
    this.skills = [
      { name: "weekly-report", description: "Draft my weekly status report from this week's sent mail, meetings and Teams threads.", source: "openscout", editable: true, body: "1. Collect this week's sent mail, meetings and Teams threads.\n2. Group by project.\n3. Write wins, risks and next week's focus in under 200 words." },
      { name: "meeting-prep", description: "Build a one-page brief before a customer meeting: attendees, history, open threads and risks.", source: "openscout", editable: true, body: "Find the meeting, its attendees and recent threads with them, then write a one-page brief." },
      { name: "docx", description: "Create, read and edit Word documents.", source: "copilot-cli", editable: false, body: "Use python-docx to build and edit .docx files." },
      { name: "xlsx", description: "Create and analyse Excel workbooks, tables and charts.", source: "copilot-cli", editable: false, body: "Use openpyxl to build and edit .xlsx files." },
    ];
    const briefingSession = [...this.sessions.values()].find((s) => s.meta.automationName === "Morning briefing");
    this.automations = [];
    this.createAutomation(
      { name: "Morning briefing", description: "Daily start-of-day summary.", schedule: "every weekday at 8am", prompt: "Brief me on today's meetings, urgent unread email and Teams mentions. Keep it to a short bulleted list.", notify: { desktop: true, email: "never" } },
      { silent: true, last: { status: "ok", summary: MORNING_BRIEF, sessionId: briefingSession?.meta.id, at: briefingSession?.meta.createdAt } },
    );
    this.createAutomation(
      { name: "Friday wrap-up", description: "Summary of the week.", schedule: "every Friday at 4pm", prompt: "Summarise my week from sent mail, meetings and Teams.", enabled: false, notify: { desktop: true, email: "auto" } },
      { silent: true },
    );
    this.createAutomation(
      { name: "Watch for the Fabrikam contract", trigger: "condition", condition: "an email from Fabrikam legal with the signed contract has arrived", checkEveryMinutes: 15, prompt: "Tell me the contract arrived and list any changes from our last redline." },
      { silent: true },
    );
    for (const s of this.sessions.values()) if (s.meta.automationName) s.meta.automationId = this.automations.find((a) => a.name === s.meta.automationName)?.id;
  }

  // ── plumbing ──
  publish(event, payload) {
    this.deliver({ event, payload });
  }
  emit(sessionId, payload) {
    this.publish("session.event", { sessionId, ...payload });
  }
  record(sessionId, entry) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.transcript.push({ t: iso(), ...entry });
    s.meta.updatedAt = iso();
  }
  sessionList() {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.meta, busy: s.busy, pending: this.pendingFor(s.meta.id).length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  publishSessions() {
    this.publish("sessions", this.sessionList());
  }
  pendingFor(sessionId) {
    const out = [];
    for (const p of this.perms.values()) if (!sessionId || p.sessionId === sessionId) out.push({ ...p.summary, type: "permission", requestId: p.id, sessionId: p.sessionId });
    for (const p of this.inputs.values()) if (!sessionId || p.sessionId === sessionId) out.push({ type: "input", requestId: p.id, sessionId: p.sessionId, question: p.question, choices: p.choices, allowFreeform: true });
    return out;
  }
  skillList() {
    const disabled = new Set(this.settings.disabledSkills);
    return this.skills
      .filter((s) => s.source === "openscout" || this.settings.skillSources.copilotCli)
      .map(({ name, description, source, editable }) => ({ name, description, source, editable, enabled: !disabled.has(name), dir: `C:\\Users\\alex\\.openscout\\skills\\${name}` }));
  }
  heartbeatInfo() {
    const hb = this.settings.heartbeat;
    const next = hb.enabled ? nextRun({ kind: "interval", minutes: hb.intervalMinutes, offsetMinute: 0, workHoursOnly: hb.schedule === "work-hours" }, new Date(), this.settings.workHours) : null;
    return { enabled: hb.enabled, nextRunAt: next ? iso(next) : undefined, running: this.running.has("heartbeat") };
  }
  automationList() {
    return this.automations.map((a) => ({
      ...a,
      scheduleText: a.trigger === "condition" ? `when: ${a.condition} (checked every ${a.checkEveryMinutes} min)` : describeSchedule(a.spec),
      running: this.running.has(a.id),
    }));
  }
  state() {
    return {
      app: { name: "OpenScout", version: "demo", host: "demo", dataDir: "your browser (demo — nothing is stored)" },
      settings: this.settings,
      github: this.github,
      workiq: this.workiq,
      models: MODELS,
      personalities: PERSONALITIES,
      sessions: this.sessionList(),
      pending: this.pendingFor(),
      automations: this.automationList(),
      heartbeat: this.heartbeatInfo(),
      memory: this.memory,
      skills: this.skillList(),
    };
  }

  // ── memory / automations used by scenarios ──
  addMemory(fact, category, source) {
    const entry = { id: rid("mem_"), fact, category, source, createdAt: iso() };
    this.memory.unshift(entry);
    this.publish("memory.changed", this.memory);
    return entry;
  }
  applyAutomationInput(a, input, isNew) {
    if (input.name !== undefined) a.name = String(input.name).trim().slice(0, 120) || a.name;
    if (input.description !== undefined) a.description = String(input.description).trim();
    if (input.steps?.length) {
      a.steps = input.steps.filter((s) => s.prompt?.trim()).map((s, i) => ({ id: rid("step_"), label: s.label?.trim() || `Step ${i + 1}`, prompt: s.prompt.trim() }));
    } else if (input.prompt !== undefined) {
      a.steps = [{ id: rid("step_"), label: "Step 1", prompt: String(input.prompt).trim() }];
    }
    if (!a.steps.length) throw new Error("An automation needs a prompt.");
    if (input.trigger) a.trigger = input.trigger;
    if (input.model !== undefined) a.model = input.model || undefined;
    if (input.enabled !== undefined) a.enabled = input.enabled;
    if (input.allowActions !== undefined) a.allowActions = input.allowActions;
    if (input.oneShot !== undefined) a.oneShot = input.oneShot;
    if (input.notify) a.notify = { ...a.notify, ...input.notify };
    if (a.trigger === "condition") {
      if (input.condition !== undefined) a.condition = String(input.condition).trim();
      if (!a.condition) throw new Error("A condition-triggered automation needs a condition to watch for.");
      a.checkEveryMinutes = [5, 15, 30, 60].includes(Number(input.checkEveryMinutes)) ? Number(input.checkEveryMinutes) : a.checkEveryMinutes ?? 15;
      a.spec = { kind: "interval", minutes: a.checkEveryMinutes, offsetMinute: 0, workHoursOnly: false };
      a.schedule = `check every ${a.checkEveryMinutes} minutes`;
      a.oneShot = true;
    } else if (input.schedule !== undefined || isNew) {
      if (!String(input.schedule ?? "").trim()) throw new Error('A scheduled automation needs a schedule, e.g. "every weekday at 9am".');
      a.spec = parseSchedule(input.schedule);
      a.schedule = String(input.schedule).trim();
    }
    const next = a.enabled ? nextRun(a.spec, new Date(), this.settings.workHours) : null;
    a.nextRunAt = next ? iso(next) : undefined;
  }
  createAutomation(input, opts = {}) {
    const now = iso();
    const a = {
      id: rid("auto_"),
      name: "Untitled automation",
      description: "",
      steps: [],
      trigger: input.trigger === "condition" ? "condition" : "schedule",
      schedule: "",
      spec: { kind: "interval", minutes: 60, offsetMinute: 0, workHoursOnly: false },
      enabled: input.enabled ?? true,
      oneShot: false,
      allowActions: false,
      notify: { desktop: true, email: "never" },
      createdAt: now,
      updatedAt: now,
    };
    this.applyAutomationInput(a, input, true);
    if (opts.last) Object.assign(a, { lastStatus: opts.last.status, lastSummary: opts.last.summary, lastSessionId: opts.last.sessionId, lastRunAt: opts.last.at });
    this.automations.push(a);
    if (!opts.silent) this.publish("automations.changed", this.automationList());
    return a;
  }
  /** Scenario helper: reuse an automation with the same name rather than creating duplicates. */
  upsertAutomation(input) {
    const existing = this.automations.find((a) => a.name === input.name);
    if (!existing) {
      this.createAutomation(input);
      this.lastAutomationVerb = "Created";
      return;
    }
    const next = structuredClone(existing);
    this.applyAutomationInput(next, { ...input, enabled: true }, false);
    next.updatedAt = iso();
    this.automations = this.automations.map((a) => (a === existing ? next : a));
    this.publish("automations.changed", this.automationList());
    this.lastAutomationVerb = "Updated your existing";
  }
  automationCreatedText(name) {
    const a = [...this.automations].reverse().find((x) => x.name === name);
    if (!a) return "Done.";
    const when = describeSchedule(a.spec);
    const next = a.nextRunAt ? new Date(a.nextRunAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "—";
    return `${this.lastAutomationVerb ?? "Created"} **${a.name}** automation — it runs ${when} (next: ${next}). It's read-only, and you'll get a desktop notification with the results. You'll find it under **Automations**, where you can also run it now.`;
  }

  async runAutomation(a, trigger) {
    const run = { id: rid("run_"), automationId: a.id, automationName: a.name, trigger, status: "running", startedAt: iso() };
    this.running.add(a.id);
    this.publish("automation.run", run);
    this.publish("automations.changed", this.automationList());
    if (a.id === "heartbeat") this.publish("heartbeat", this.heartbeatInfo());
    await sleep(2200);
    const s = this.newSession(undefined, { origin: "automation", automationId: a.id, automationName: a.name, title: `${a.name} · ${fmtStamp()}` });
    for (const step of a.steps) this.record(s.meta.id, { kind: "user", text: step.prompt });
    this.record(s.meta.id, { kind: "tool", toolCallId: rid("call_"), name: "m365_search", args: '{\n  "query": "…"\n}', success: true, result: "(demo results)" });
    const text =
      a.id === "heartbeat"
        ? "- Dana Whitfield (Fabrikam) is waiting on multi-year pricing options before the 11:00 call."
        : /wrap|friday/i.test(a.name)
          ? WRAP_UP
          : /brief/i.test(a.name)
            ? MORNING_BRIEF
            : a.trigger === "condition"
              ? "The signed contract from Fabrikam legal arrived at 10:42. Changes vs our last redline: §7 liability cap raised to 2× fees; renewal term set to 3 years."
              : `Ran **${a.name}**. *(Demo output — the real app would run your prompt with GitHub Copilot and your Microsoft 365 data.)*`;
    this.record(s.meta.id, { kind: "assistant", text });
    Object.assign(run, { status: "ok", summary: text, sessionId: s.meta.id, finishedAt: iso() });
    this.runs.unshift(run);
    this.running.delete(a.id);
    const cur = this.automations.find((x) => x.id === a.id);
    if (cur) Object.assign(cur, { lastRunAt: run.startedAt, lastStatus: "ok", lastSummary: text, lastSessionId: s.meta.id });
    this.publish("automation.run", run);
    this.publish("automations.changed", this.automationList());
    if (a.id === "heartbeat") this.publish("heartbeat", this.heartbeatInfo());
    this.publishSessions();
    if (a.notify?.desktop !== false && this.settings.notifications.desktop) this.publish("notify", { title: a.name, body: text.replace(/[*_#>]/g, "").slice(0, 280), sessionId: s.meta.id, kind: "automation" });
    return run;
  }

  // ── conversations ──
  newSession(id, opts = {}) {
    const now = iso();
    const s = {
      meta: {
        id: id ?? crypto.randomUUID(),
        title: opts.title ?? "New conversation",
        titleSource: opts.title ? "user" : "auto",
        createdAt: now,
        updatedAt: now,
        model: opts.model || this.settings.defaultModel || "auto",
        origin: opts.origin ?? "chat",
        automationId: opts.automationId,
        automationName: opts.automationName,
      },
      transcript: [],
      busy: false,
    };
    this.sessions.set(s.meta.id, s);
    return s;
  }

  async runTurn(sessionId, prompt) {
    const s = this.sessions.get(sessionId);
    const ctl = { aborted: false };
    this.turns.set(sessionId, ctl);
    try {
      await sleep(400);
      await this.play(sessionId, scenarioFor(prompt, this), ctl);
    } catch (err) {
      this.emit(sessionId, { kind: "error", text: String(err?.message ?? err) });
    } finally {
      this.turns.delete(sessionId);
      if (s && this.sessions.has(sessionId)) {
        s.busy = false;
        s.meta.usage = { currentTokens: Math.min(TOKEN_LIMIT, (s.meta.usage?.currentTokens ?? 21000) + 2500 + Math.floor(Math.random() * 3000)), tokenLimit: TOKEN_LIMIT };
        this.emit(sessionId, { kind: "usage", ...s.meta.usage });
        this.emit(sessionId, { kind: "idle" });
        this.publishSessions();
      }
    }
  }

  async play(sessionId, steps, ctl) {
    for (const step of steps) {
      if (ctl.aborted) {
        this.emit(sessionId, { kind: "info", text: "Stopped." });
        return;
      }
      switch (step.type) {
        case "intent":
          this.emit(sessionId, { kind: "intent", intent: step.text });
          break;
        case "think":
          await this.stream(sessionId, step.text, ctl, true);
          break;
        case "tool":
          await this.runTool(sessionId, step);
          break;
        case "say":
          await this.stream(sessionId, step.text, ctl, false);
          break;
        case "say-dynamic":
          await this.stream(sessionId, step.text(), ctl, false);
          break;
        case "effect":
          step.run();
          break;
        case "permission": {
          const decision = await this.ask(this.perms, sessionId, { summary: step.summary });
          this.record(sessionId, { kind: "permission", title: step.summary.title, detail: step.summary.detail, decision });
          await this.play(sessionId, decision === "deny" ? step.onDeny : step.onAllow, ctl);
          return;
        }
        case "input": {
          const answer = await this.ask(this.inputs, sessionId, { question: step.question, choices: step.choices });
          this.record(sessionId, { kind: "input", question: step.question, answer });
          await this.play(sessionId, step.then(answer), ctl);
          return;
        }
      }
    }
  }

  /** Registers a pending approval/question, shows it in the UI and waits for the answer. */
  ask(map, sessionId, fields) {
    return new Promise((resolve) => {
      const id = rid(map === this.perms ? "perm_" : "ask_");
      map.set(id, { id, sessionId, ...fields, resolve });
      if (map === this.perms) this.emit(sessionId, { ...fields.summary, kind: "permission.request", requestId: id });
      else this.emit(sessionId, { kind: "input.request", requestId: id, question: fields.question, choices: fields.choices ?? [], allowFreeform: true });
      this.publishSessions();
    });
  }

  async stream(sessionId, text, ctl, reasoning) {
    const id = rid(reasoning ? "r_" : "msg_");
    const parts = text.match(/\S+\s*|\s+/g) ?? [text];
    let i = 0;
    while (i < parts.length && !ctl.aborted) {
      const n = 2 + Math.floor(Math.random() * 3);
      const delta = parts.slice(i, i + n).join("");
      i += n;
      this.emit(sessionId, reasoning ? { kind: "reasoning.delta", reasoningId: id, delta } : { kind: "assistant.delta", messageId: id, delta });
      await sleep(reasoning ? 12 : 26);
    }
    if (reasoning) return;
    const final = ctl.aborted ? parts.slice(0, i).join("") : text;
    this.emit(sessionId, { kind: "assistant.message", messageId: id, text: final });
    this.record(sessionId, { kind: "assistant", text: final, messageId: id });
  }

  async runTool(sessionId, step) {
    const toolCallId = rid("call_");
    const args = JSON.stringify(step.args ?? {}, null, 2);
    this.emit(sessionId, { kind: "tool.start", toolCallId, name: step.name, server: step.server, args });
    await sleep(600 + Math.random() * 700);
    this.emit(sessionId, { kind: "tool.complete", toolCallId, success: true, result: step.result });
    this.record(sessionId, { kind: "tool", toolCallId, name: step.name, server: step.server, args, success: true, result: step.result });
  }

  settle(map, sessionId, value) {
    for (const p of [...map.values()]) {
      if (p.sessionId !== sessionId) continue;
      map.delete(p.id);
      p.resolve(value);
    }
  }

  // ── RPC surface (mirrors src/server/app.ts) ──
  async handle(method, p) {
    switch (method) {
      case "state":
        return this.state();
      case "sessions.list":
        return this.sessionList();
      case "session.open": {
        const s = this.sessions.get(String(p.id));
        if (!s) throw new Error("Conversation not found.");
        return { meta: s.meta, transcript: s.transcript, pending: this.pendingFor(s.meta.id), busy: s.busy };
      }
      case "session.send": {
        const prompt = String(p.prompt ?? "").trim();
        if (!prompt) throw new Error("Message is empty.");
        let s = p.sessionId ? this.sessions.get(p.sessionId) : undefined;
        if (p.isNew) {
          if (s) throw new Error("Invalid or duplicate conversation id.");
          s = this.newSession(p.sessionId, { model: p.model });
        } else if (!s) {
          throw new Error("Conversation not found.");
        }
        if (s.busy) throw new Error("OpenScout is still working on the previous message.");
        s.busy = true;
        if (s.meta.titleSource === "auto" && !s.meta.preview) s.meta.title = makeTitle(prompt);
        s.meta.preview = prompt.slice(0, 160);
        const names = (p.attachments ?? []).map((a) => a.name || "attachment");
        this.record(s.meta.id, { kind: "user", text: prompt, ...(names.length ? { attachments: names } : {}) });
        this.emit(s.meta.id, { kind: "user", text: prompt, attachments: names });
        this.publishSessions();
        void this.runTurn(s.meta.id, prompt);
        return { sessionId: s.meta.id };
      }
      case "session.abort": {
        const ctl = this.turns.get(String(p.id));
        if (ctl) ctl.aborted = true;
        this.settle(this.perms, String(p.id), "deny");
        this.settle(this.inputs, String(p.id), "(stopped)");
        return true;
      }
      case "session.delete": {
        const id = String(p.id);
        const ctl = this.turns.get(id);
        if (ctl) ctl.aborted = true;
        this.settle(this.perms, id, "deny");
        this.settle(this.inputs, id, "(deleted)");
        this.sessions.delete(id);
        this.publishSessions();
        return true;
      }
      case "session.rename": {
        const s = this.sessions.get(String(p.id));
        if (!s) throw new Error("Conversation not found.");
        s.meta.title = String(p.title ?? "").trim().slice(0, 120) || s.meta.title;
        s.meta.titleSource = "user";
        this.publishSessions();
        return true;
      }
      case "session.setModel": {
        const s = this.sessions.get(String(p.id));
        if (s) s.meta.model = String(p.model);
        this.publishSessions();
        return true;
      }
      case "session.search": {
        const terms = String(p.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return [];
        const hits = [];
        for (const meta of this.sessionList()) {
          const s = this.sessions.get(meta.id);
          const titleHit = terms.every((t) => meta.title.toLowerCase().includes(t));
          let snippet = "";
          for (const e of s.transcript) {
            const text = e.kind === "user" || e.kind === "assistant" ? e.text : "";
            if (text && terms.every((t) => text.toLowerCase().includes(t))) {
              const at0 = Math.max(0, text.toLowerCase().indexOf(terms[0]) - 60);
              snippet = `${at0 > 0 ? "…" : ""}${text.slice(at0, at0 + 200).replace(/\s+/g, " ")}…`;
              break;
            }
          }
          if (titleHit || snippet) hits.push({ sessionId: meta.id, title: meta.title, updatedAt: meta.updatedAt, snippet });
        }
        return hits;
      }
      case "permission.respond": {
        const pend = this.perms.get(String(p.requestId));
        if (!pend) return false;
        this.perms.delete(pend.id);
        pend.resolve(p.decision === "deny" ? "deny" : p.decision === "session" ? "session" : "once");
        this.emit(pend.sessionId, { kind: "permission.resolved", requestId: pend.id, decision: p.decision });
        this.publishSessions();
        return true;
      }
      case "input.respond": {
        const pend = this.inputs.get(String(p.requestId));
        if (!pend) return false;
        this.inputs.delete(pend.id);
        pend.resolve(String(p.answer ?? ""));
        this.emit(pend.sessionId, { kind: "input.resolved", requestId: pend.id, answer: String(p.answer ?? "") });
        this.publishSessions();
        return true;
      }

      case "settings.update": {
        const prev = this.settings;
        this.settings = deepMerge(this.settings, p.patch ?? {});
        this.publish("settings.changed", this.settings);
        if (JSON.stringify(prev.heartbeat) !== JSON.stringify(this.settings.heartbeat) || JSON.stringify(prev.workHours) !== JSON.stringify(this.settings.workHours)) {
          this.publish("heartbeat", this.heartbeatInfo());
        }
        if (JSON.stringify(prev.skillSources) !== JSON.stringify(this.settings.skillSources)) this.publish("skills.changed", this.skillList());
        return this.settings;
      }
      case "github.refresh":
      case "github.importCli":
        return this.github;
      case "github.openLogin":
        return { launched: false, instructions: "Sign-in isn't available in the browser demo. Install OpenScout from GitHub to use your own GitHub Copilot account." };
      case "models.refresh":
        return MODELS;
      case "workiq.refresh":
      case "workiq.restart":
        return this.workiq;

      case "memory.list":
        return this.memory;
      case "memory.add": {
        const fact = String(p.fact ?? "").trim();
        if (!fact) throw new Error("Fact is empty.");
        return this.addMemory(fact, p.category || "fact", "user");
      }
      case "memory.delete": {
        const before = this.memory.length;
        this.memory = this.memory.filter((m) => m.id !== p.id);
        this.publish("memory.changed", this.memory);
        return this.memory.length < before;
      }

      case "automations.list":
        return { automations: this.automationList(), heartbeat: this.heartbeatInfo() };
      case "automation.create":
        return this.createAutomation(p.input ?? {});
      case "automation.update": {
        const cur = this.automations.find((a) => a.id === p.id);
        if (!cur) throw new Error("Automation not found.");
        const next = structuredClone(cur);
        this.applyAutomationInput(next, p.input ?? {}, false);
        next.updatedAt = iso();
        this.automations = this.automations.map((a) => (a === cur ? next : a));
        this.publish("automations.changed", this.automationList());
        return next;
      }
      case "automation.delete":
        this.automations = this.automations.filter((a) => a.id !== p.id);
        this.publish("automations.changed", this.automationList());
        return true;
      case "automation.run": {
        if (p.id === "heartbeat") {
          if (this.running.has("heartbeat")) throw new Error("The heartbeat is already running.");
          const hb = { id: "heartbeat", name: "Heartbeat", steps: [{ prompt: this.settings.heartbeat.prompt }], notify: { desktop: true } };
          void this.runAutomation(hb, "manual");
          return { id: rid("run_"), automationId: "heartbeat", automationName: "Heartbeat", status: "running" };
        }
        const a = this.automations.find((x) => x.id === p.id);
        if (!a) throw new Error("Automation not found.");
        if (this.running.has(a.id)) throw new Error(`"${a.name}" is already running.`);
        void this.runAutomation(a, "manual");
        return { id: rid("run_"), automationId: a.id, automationName: a.name, status: "running" };
      }
      case "automation.runs":
        return this.runs.filter((r) => !p.id || r.automationId === p.id).slice(0, Number(p.limit) || 30);
      case "schedule.preview":
        try {
          const spec = parseSchedule(String(p.text ?? ""));
          const next = nextRun(spec, new Date(), this.settings.workHours);
          return { ok: true, description: describeSchedule(spec), next: next ? iso(next) : undefined };
        } catch (err) {
          return { ok: false, error: err.message };
        }

      case "skills.list":
        return this.skillList();
      case "skill.get": {
        const s = this.skills.find((x) => x.name === p.name);
        if (!s) return null;
        const info = this.skillList().find((x) => x.name === s.name);
        return { ...info, content: `---\nname: "${s.name}"\ndescription: "${s.description}"\n---\n\n${s.body}\n` };
      }
      case "skill.save": {
        const name = String(p.name ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("Skill names use lowercase letters, numbers and hyphens.");
        const description = String(p.description ?? "").trim();
        if (!description) throw new Error("A description is required so the agent knows when to use the skill.");
        const existing = this.skills.find((s) => s.name === name);
        if (existing && !existing.editable) throw new Error(`"${name}" can't be edited here.`);
        const skill = { name, description, source: "openscout", editable: true, body: String(p.instructions ?? description) };
        this.skills = existing ? this.skills.map((s) => (s === existing ? skill : s)) : [...this.skills, skill];
        this.publish("skills.changed", this.skillList());
        return this.skillList().find((s) => s.name === name);
      }
      case "skill.delete":
        this.skills = this.skills.filter((s) => !(s.name === p.name && s.editable));
        this.publish("skills.changed", this.skillList());
        return true;
      case "skill.toggle": {
        const disabled = new Set(this.settings.disabledSkills);
        if (p.enabled) disabled.delete(p.name);
        else disabled.add(p.name);
        this.settings = { ...this.settings, disabledSkills: [...disabled] };
        this.publish("skills.changed", this.skillList());
        return this.skillList();
      }

      case "github.token":
      case "workiq.acceptEula":
      case "workiq.signIn":
      case "workiq.signOut":
      case "os.openPath":
      case "os.openWorkingFolder":
      case "os.openDataFolder":
        throw new Error(NOT_IN_DEMO);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

/** Looks like a WebSocket to web/core.js, but talks to the in-browser DemoServer. */
export class DemoSocket {
  constructor() {
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.server = new DemoServer((msg) => this.deliver(msg));
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.deliver({ event: "hello", payload: this.server.state() });
    }, 30);
  }

  send(data) {
    const msg = JSON.parse(data);
    Promise.resolve()
      .then(() => this.server.handle(msg.method, msg.params ?? {}))
      .then((result) => this.deliver({ id: msg.id, ok: true, result }))
      .catch((err) => this.deliver({ id: msg.id, ok: false, error: err?.message ?? String(err) }));
  }

  close() {}

  deliver(obj) {
    // Serialise like the real WebSocket so the UI never shares objects with the simulated server.
    const data = JSON.stringify(obj);
    setTimeout(() => this.onmessage?.({ data }), 0);
  }
}
