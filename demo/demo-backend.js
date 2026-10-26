// OpenScout browser demo for students: a simulated backend so the real UI can run on a static website.
// Everything here is fictional (Contoso University sample data). No network, AI or Microsoft 365 calls are made.
import { describeSchedule, nextRun, parseSchedule } from "./schedule.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d = new Date()) => d.toISOString();
const rid = (p) => `${p}${Math.random().toString(36).slice(2, 10)}`;
const WORK_HOURS = { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const TOKEN_LIMIT = 272000;
const NOT_IN_DEMO = "That needs the desktop app — it isn't available in the browser demo.";

const USER = {
  displayName: "Alex Chen",
  mail: "alex.chen@student.contoso.edu",
  userPrincipalName: "alex.chen@student.contoso.edu",
  jobTitle: "BSc Computer Science · Year 2",
};

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
  { id: "tutor", name: "Tutor", description: "Patient, explains step by step." },
  { id: "formal", name: "Formal", description: "Polished, executive-ready tone." },
];

const SCOPE_GROUPS = [
  { id: "channels", label: "Teams channel messages" },
  { id: "education", label: "Class assignments and rosters (Teams for Education)" },
];
const CORE_TOOLS = ["m365_search", "m365_fetch", "m365_function", "m365_fetch_file", "m365_create", "m365_update", "m365_delete", "m365_action"];

function defaultSettings() {
  return {
    theme: "system",
    defaultModel: "auto",
    reasoningEffort: "",
    personality: "tutor",
    audience: "student",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDirectory: "C:\\Users\\alex\\Documents\\OpenScout",
    permissions: { mode: "auto-read", shellAllow: ["Get-ChildItem", "Get-Content", "Get-Date", "Test-Path"] },
    m365: {
      enabled: true,
      provider: "graph",
      clientId: "6b1f0d8e-2c4a-4f7e-9a51-3d2e8c7b9f10",
      tenant: "contoso.edu",
      scopeGroups: ["education"],
      copilotLicense: false,
      account: "",
    },
    browser: { enabled: true, channel: "msedge", headless: false },
    github: { mcpEnabled: true },
    notifications: { desktop: true, email: true },
    heartbeat: {
      enabled: false,
      intervalMinutes: 60,
      schedule: "work-hours",
      prompt: "Check my school email, today's classes and Teams class posts. Only surface what needs attention soon; otherwise reply [[quiet]].",
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
const fmtShortDay = (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
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

function classesAnswer() {
  const t = (h, m) => fmtTime(at(h, m));
  return [
    `### ${fmtDay(new Date())}`,
    "",
    "| Time | Class | Where / notes |",
    "| --- | --- | --- |",
    `| ${t(9, 0)}–${t(11, 0)} | **ALGO2201 Lecture** — Graph algorithms | Lakeside Hall G03 |`,
    `| ${t(11, 0)}–${t(12, 0)} | STAT2105 Tutorial — Problem set 9 | Science Hub 2.73 |`,
    `| ${t(11, 30)}–${t(12, 0)} | HCID2300 Team 7 sync | ⚠️ Clashes with your STAT2105 tutorial (Teams) |`,
    `| ${t(15, 0)}–${t(17, 0)} | Study block | Library, level 3 |`,
    `| ${t(17, 30)} | ALGO2201 Quiz 4 closes | Teams Assignments |`,
    "",
    "**Clash:** your Team 7 sync overlaps the STAT2105 tutorial. Want me to ask Mia, Leo and Priya to move it to 12:15?",
    "",
    "**Prepare:** skim the Week 9 slides on Dijkstra's algorithm before the lecture, and bring your attempt at problem set 9, Q3, to the tutorial.",
  ].join("\n");
}

function assignmentsAnswer() {
  const d = (n) => fmtShortDay(at(17, 0, n));
  return [
    "**Due in the next two weeks** — sorted by due date",
    "",
    "| Due | Course | Assignment | Status | Effort left |",
    "| --- | --- | --- | --- | --- |",
    `| Today 5:30pm | ALGO2201 | Quiz 4 (online, 20 min) | Not started | 20 min |`,
    `| ${d(2)} 5pm | ALGO2201 | Assignment 2: Shortest paths (Python) | In progress (about 60%) | ~6 h |`,
    `| ${d(4)} 11:59pm | STAT2105 | Problem set 9 | Not started | ~3 h |`,
    `| ${d(5)} 5pm | HCID2300 | Project milestone 2: prototype (Team 7) | Team doc 40% | ~4 h each |`,
    `| ${d(9)} 9am | ALGO2201 | Quiz 5 | Not started | revise BFS/DFS |`,
    "",
    "**Suggestion:** do Quiz 4 before 5:30pm today, then two 45-minute blocks on Assignment 2 tonight. Want me to add study blocks to your calendar?",
  ].join("\n");
}

const LECTURE_NOTES = [
  "### ALGO2201 Week 9 — Shortest paths (Dijkstra's algorithm)",
  "",
  "**Key points**",
  "- Dijkstra finds the shortest path from one source to every vertex when **all edge weights are non-negative**.",
  "- It repeatedly takes the closest unvisited vertex (a min-priority queue) and *relaxes* its outgoing edges.",
  "- With a binary heap it runs in **O((V + E) log V)**.",
  "- Negative edges break it; use Bellman–Ford instead (O(VE)), which also detects negative cycles.",
  "",
  "**Key terms:** relaxation, priority queue, shortest-path tree, greedy choice.",
  "",
  "**Practice questions**",
  "1. Why does Dijkstra fail with a negative edge? Give a 3-vertex example.",
  "2. Trace Dijkstra from A on the lecture's 5-vertex graph and list the order vertices are finalised.",
  "3. What changes in the running time if you use an unsorted array instead of a heap?",
  "",
  "<details><summary>Show answers</summary>",
  "",
  "1. A finalised vertex can later be reached more cheaply through a negative edge, but Dijkstra never revisits it. Example: A→B (2), A→C (5), C→B (−4).",
  "2. A, C, B, E, D (distances 0, 2, 3, 6, 8).",
  "3. Finding the minimum costs O(V) each time, so the total becomes O(V²), which is better for dense graphs.",
  "</details>",
].join("\n");

const TEAMS_ANSWER = [
  "**HCID2300 — Team 7 chat, since yesterday**",
  "",
  "- **Mia** uploaded the new wireframes to the team's Files tab and wants feedback by Wednesday.",
  "- **Leo** asked who's presenting at Friday's milestone check-in. Nobody has replied yet.",
  "- **Priya** needs your user-research notes by **Thursday** so she can finish the persona slide.",
  "",
  "Want me to draft a reply offering to present and confirming your notes will be ready Wednesday night?",
].join("\n");

const DIAGRAM_ANSWER = [
  "Here's a concept map comparing the two traversals:",
  "",
  "```mermaid",
  "flowchart TB",
  "  G[Graph traversal] --> B[Breadth-first search]",
  "  G --> D[Depth-first search]",
  "  B --> BQ[Uses a queue]",
  "  B --> BS[Shortest paths in unweighted graphs]",
  "  D --> DS[Uses a stack or recursion]",
  "  D --> DT[Topological sort, cycle detection]",
  "  BS --> DJ[Weighted edges? Use Dijkstra]",
  "```",
  "",
  "**Check yourself:** which one would you use to find the fewest flights between two airports, and why?",
].join("\n");

const INTEGRITY_ANSWER = [
  "I can't write an assessment for you to submit as your own — that would breach your university's academic-integrity policy. I can help you get it done well yourself, though:",
  "",
  "1. **Unpack the brief:** I'll turn the marking rubric into a checklist.",
  "2. **Plan:** I'll draft an outline with you, section by section.",
  "3. **Get feedback:** paste a paragraph and I'll point out what's strong and what to tighten.",
  "4. **Cite properly:** I'll format your references in APA 7th.",
  "",
  "Where would you like to start?",
].join("\n");

const CAPABILITIES_ANSWER = [
  "I'm OpenScout, a study assistant that runs on your laptop. With your school Microsoft 365 account and GitHub Copilot I can:",
  "",
  "- **Stay on top of uni:** check your classes, assignments and deadlines, school email and Teams class chats.",
  "- **Learn faster:** turn lecture slides into notes and practice questions, explain concepts step by step, and quiz you.",
  "- **Plan:** build study plans around your timetable, and run automations such as a Sunday-evening weekly plan or a deadline radar.",
  "- **Communicate:** draft emails to tutors or your project team. Nothing is sent without your OK.",
  "- **Work with files:** read and organise documents, and draft outlines and reference lists, while you write your own assessments.",
  "",
  "You don't need a Microsoft 365 Copilot licence. Students can get GitHub Copilot through GitHub Education.",
].join("\n");

const DEFAULT_ANSWER = [
  "This is the **student demo** of OpenScout, so I can only play back a few scripted scenarios with fictional Contoso University data. No AI model or Microsoft 365 account is connected.",
  "",
  "Try asking about:",
  "- your **classes today**, **assignments due** or your **group project** chat",
  "- turning **lecture slides into notes**, a **quiz**, or a **diagram** of a concept",
  "- **emailing your tutor** for an extension (you'll see an approval prompt)",
  "- a **weekly study plan** automation, or **remembering** your exam date",
  "",
  "To use OpenScout for real, install it from GitHub. You only need your school Microsoft 365 account and GitHub Copilot.",
].join("\n");

const STUDY_PLAN = [
  "**Your study week** (45-minute blocks, built around your timetable)",
  "",
  "| Day | Plan |",
  "| --- | --- |",
  "| Mon | 2 × ALGO2201 Assignment 2 (finish Dijkstra implementation) |",
  "| Tue | 1 × Assignment 2 tests and write-up · **due 5pm** |",
  "| Wed | 2 × STAT2105 problem set 9 · send research notes to Priya |",
  "| Thu | 1 × problem set 9 · **due 11:59pm** · 1 × HCID2300 prototype |",
  "| Fri | Team 7 milestone check-in · 1 × revise BFS/DFS for Quiz 5 |",
  "| Sat | Rest |",
  "| Sun | 1 × weekly review · 1 × flashcards for the ALGO2201 exam (18 Nov) |",
].join("\n");

const RADAR = [
  "**Assignment radar**",
  "- ALGO2201 Quiz 4 closes **today 5:30pm**",
  "- ALGO2201 Assignment 2 due **Tuesday 5pm** (about 6 hours left)",
  "- New in Teams: HCID2300 milestone 2 rubric posted by Dr Okafor",
].join("\n");

function scenarioFor(prompt, server) {
  const q = prompt.toLowerCase();

  if (/^\s*remember\b/.test(q) || /\bremember that\b/.test(q)) {
    const fact = prompt.replace(/^\s*(please\s+)?remember( that)?\s*/i, "").trim() || prompt.trim();
    return [
      tool("memory_remember", { fact, category: "fact" }, "Saved to memory."),
      { type: "effect", run: () => server.addMemory(fact, "fact", "agent") },
      say(`Got it — I'll remember that: *${fact}*. You can review it under **Memory**.`),
    ];
  }

  if (/\b(write|do|complete|finish) (my|the) (essay|assignment|assessment|report|homework)\b/.test(q)) return [say(INTEGRITY_ANSWER)];

  if (/\b(automation|every (week)?day|every (sunday|monday|weekday)|weekdays?|remind|radar|study plan|study week)\b/.test(q)) {
    const plan = /study (plan|week)|plan my study|sunday/.test(q);
    const name = plan ? "Weekly study plan" : /assignment|deadline|radar/.test(q) ? "Assignment radar" : "New automation";
    let schedule = plan ? "every Sunday at 6pm" : "every weekday at 8am";
    const m = /\b(every[^,.]*?\bat\b[^,.]*?(?:am|pm|\d{2}:\d{2}))/i.exec(prompt);
    if (m) {
      try {
        parseSchedule(m[1]);
        schedule = m[1].trim();
      } catch {
        // keep the default
      }
    }
    const automationPrompt = plan
      ? "Plan my study week around my classes, deadlines and exams in 45-minute blocks with breaks. Show it as a day-by-day table."
      : name === "Assignment radar"
        ? "Check my school email and Teams class posts for new or changed assignments and deadlines. List what's due in the next 7 days."
        : prompt.trim();
    return [
      intent("Setting up the automation"),
      tool("automation_create", { name, schedule, prompt: automationPrompt, desktopNotify: true }, `Saved automation "${name}".`),
      { type: "effect", run: () => server.upsertAutomation({ name, schedule, prompt: automationPrompt, notify: { desktop: true, email: "never" } }) },
      { type: "say-dynamic", text: () => server.automationCreatedText(name) },
    ];
  }

  if (/\b(email|reply|write to|message)\b/.test(q) && /\b(tutor|lecturer|professor|dr|extension|nguyen|teacher)\b/.test(q)) {
    const to = { name: "Dr Maya Nguyen", address: "m.nguyen@contoso.edu" };
    const body =
      "Dear Dr Nguyen,\n\nI've been unwell this week (I have a medical certificate) and I'm behind on ALGO2201 Assignment 2. Could I please have a one-week extension? I've also lodged a special consideration request.\n\nKind regards,\nAlex Chen (SID 4801 2219)";
    return [
      say(`Here's a draft to **${to.name}**:\n\n> ${body.replace(/\n/g, "\n> ")}\n\nTip: most universities also want a formal special consideration request, so I mentioned it. I'll send this once you approve.`),
      {
        type: "permission",
        summary: {
          kind: "m365",
          permissionKind: "m365",
          title: "Send an email",
          detail: `POST /me/sendMail\n\n${JSON.stringify({ message: { subject: "ALGO2201 Assignment 2 — extension request", toRecipients: [{ emailAddress: to }], body: { contentType: "Text", content: body } } }, null, 2)}`,
          readOnly: false,
          risk: "high",
          allowSession: false,
          toolName: "m365_action",
        },
        onAllow: [
          tool("m365_action", { actionUrl: "/me/sendMail", jsonBody: { message: { toRecipients: [{ emailAddress: to }] } } }, "202 Accepted (demo — nothing was actually sent)"),
          say(`Sent to ${to.name}. *(In this demo nothing leaves your browser.)* Want a reminder on Wednesday if there's no reply?`),
        ],
        onDeny: [say("No problem — I didn't send it. Want me to save it as a draft in Outlook so you can tweak it first?")],
      },
    ];
  }

  if (/\b(assignments?|deadlines?|due|homework)\b/.test(q)) {
    return [
      intent("Checking your assignments"),
      think("I'll read the student's Teams assignments, then cross-check school email for deadline changes the class posted."),
      tool(
        "m365_fetch",
        { entityUrls: ["/education/me/assignments?$select=displayName,dueDateTime,status,classId&$top=50"] },
        '{"statusCode":200,"data":{"value":[{"displayName":"Assignment 2: Shortest paths","dueDateTime":"…","status":"assigned"},"… 4 more"]}}',
      ),
      tool("m365_search", { query: "assignment OR deadline OR extension", entityTypes: ["message", "chatMessage"], size: 8 }, "### Emails (message) — 6 matches …\n### Teams messages (chatMessage) — 3 matches …"),
      say(assignmentsAnswer()),
    ];
  }

  if (/\b(teams|group|project|team 7|chats?|mention(ed|s)?)\b/.test(q)) {
    return [
      intent("Catching up on your group chat"),
      tool("m365_search", { query: "HCID2300 Team 7", entityTypes: ["chatMessage"], size: 10 }, "### Teams messages (chatMessage) — 9 matches, showing 1–9 …"),
      say(TEAMS_ANSWER),
    ];
  }

  if (/\b(quiz|test me|flashcards?)\b/.test(q)) {
    return [
      {
        type: "input",
        question: "Which topic should I quiz you on?",
        choices: ["Graph traversal (BFS/DFS)", "Dijkstra's algorithm", "Big-O notation", "Probability basics"],
        then: (answer) => [say(quizFor(answer))],
      },
    ];
  }

  if (/\b(classes|class|timetable|lectures? today|calendar|today|schedule)\b/.test(q)) {
    return [
      intent("Reading your timetable"),
      tool(
        "m365_fetch",
        { entityUrls: [`/me/calendarView?startDateTime=${iso(at(0, 0))}&endDateTime=${iso(at(23, 59))}&$select=subject,start,end,location`] },
        '{"statusCode":200,"data":{"value":["ALGO2201 Lecture","STAT2105 Tutorial","HCID2300 Team 7 sync","Study block"]}}',
      ),
      tool("m365_fetch", { entityUrls: ["/education/me/assignments?$select=displayName,dueDateTime&$top=10"] }, '{"statusCode":200,"data":{"value":["Quiz 4 (closes 5:30pm)","…"]}}'),
      say(classesAnswer()),
    ];
  }

  if (/\b(lecture|slides?|notes|summari[sz]e|deck|pptx?|pdf)\b/.test(q)) {
    return [
      intent("Finding your lecture slides"),
      tool("m365_search", { query: "ALGO2201 Week 9 filetype:pptx", entityTypes: ["driveItem"], size: 5 }, "### Files (driveItem) — 4 matches\n1. **ALGO2201 Week 9 - Shortest paths.pptx** — modified yesterday"),
      tool("m365_fetch_file", { path: "/drives/demo/items/demo/content", format: "pdf" }, "Saved 3,214,880 bytes (application/pdf) to C:\\Users\\alex\\Documents\\OpenScout\\Downloads\\ALGO2201 Week 9 - Shortest paths.pdf"),
      say(LECTURE_NOTES),
    ];
  }

  if (/\b(diagram|mermaid|concept map|mind ?map|flowchart|visuali[sz]e|bfs|dfs)\b/.test(q)) return [say(DIAGRAM_ANSWER)];

  if (/\b(what can you do|capabilit|help|tour|who are you)\b/.test(q)) return [say(CAPABILITIES_ANSWER)];

  return [say(DEFAULT_ANSWER)];
}

function quizFor(topic) {
  const banks = {
    "Graph traversal (BFS/DFS)": [
      ["Which data structure does BFS use?", "A queue (first in, first out)."],
      ["Which traversal finds the shortest path in an unweighted graph?", "BFS, because it explores vertices in order of distance."],
      ["What is the time complexity of DFS with an adjacency list?", "O(V + E)."],
      ["Name one problem DFS solves that BFS doesn't solve as naturally.", "Topological sorting (or cycle detection in directed graphs)."],
      ["Can BFS loop forever on a graph with cycles?", "Not if you mark vertices as visited when you enqueue them."],
    ],
    "Dijkstra's algorithm": [
      ["What must be true of edge weights for Dijkstra to be correct?", "They must be non-negative."],
      ["Which data structure makes Dijkstra efficient?", "A min-priority queue (binary heap)."],
      ["What does 'relaxing' an edge mean?", "Updating a neighbour's distance if going through the current vertex is shorter."],
      ["Running time with a binary heap?", "O((V + E) log V)."],
      ["Which algorithm handles negative edges?", "Bellman–Ford."],
    ],
    "Big-O notation": [
      ["What's the Big-O of binary search?", "O(log n)."],
      ["Simplify O(3n² + 10n + 7).", "O(n²)."],
      ["Which grows faster: O(n log n) or O(n²)?", "O(n²)."],
      ["Accessing an array element by index?", "O(1)."],
      ["A loop inside a loop, both over n items?", "O(n²)."],
    ],
    "Probability basics": [
      ["P(A or B) for mutually exclusive events?", "P(A) + P(B)."],
      ["If P(A) = 0.3, what's P(not A)?", "0.7."],
      ["Two fair coin flips: P(two heads)?", "0.25."],
      ["What does it mean for A and B to be independent?", "P(A and B) = P(A) × P(B)."],
      ["Expected value of a fair six-sided die?", "3.5."],
    ],
  };
  const qs = banks[topic] ?? banks["Graph traversal (BFS/DFS)"];
  return [
    `**${topic} — five questions.** Try each one before you reveal the answer.`,
    "",
    ...qs.flatMap(([question, answer], i) => [`${i + 1}. ${question}`, "", `<details><summary>Show answer</summary>${answer}</details>`, ""]),
    "How did you go? Tell me which ones you missed and I'll explain them with an example.",
  ].join("\n");
}

// ── Seed data ───────────────────────────────────────────────────────────────

function seedSessions() {
  const sessions = [];
  const add = (meta, transcript) => sessions.push({ meta: { titleSource: "user", model: "auto", origin: "chat", ...meta }, transcript, busy: false });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600e3);
  add(
    { id: crypto.randomUUID(), title: "Explain Dijkstra's algorithm with an example", createdAt: iso(twoHoursAgo), updatedAt: iso(twoHoursAgo), usage: { currentTokens: 18400, tokenLimit: TOKEN_LIMIT } },
    [
      { t: iso(twoHoursAgo), kind: "user", text: "Explain Dijkstra's algorithm with an example — I don't get the lecture slides." },
      {
        t: iso(twoHoursAgo),
        kind: "assistant",
        text: [
          "Let's start with an example and get to the theory after.",
          "",
          "Imagine travel times from **A**: A→B = 4, A→C = 1, C→B = 2, B→D = 1.",
          "",
          "1. Start at A with distance 0. Everything else is ∞.",
          "2. The closest unvisited vertex is **C** (1). Going C→B costs 1 + 2 = 3, which beats 4, so B becomes 3.",
          "3. Next closest is **B** (3). Going B→D makes D = 4.",
          "4. Then **D** (4). Done: A=0, C=1, B=3, D=4.",
          "",
          "```python",
          "import heapq",
          "def dijkstra(graph, src):",
          "    dist = {v: float('inf') for v in graph}; dist[src] = 0",
          "    pq = [(0, src)]",
          "    while pq:",
          "        d, u = heapq.heappop(pq)",
          "        if d > dist[u]: continue",
          "        for v, w in graph[u]:",
          "            if d + w < dist[v]:",
          "                dist[v] = d + w; heapq.heappush(pq, (dist[v], v))",
          "    return dist",
          "```",
          "",
          "**Quick check:** why do we skip `d > dist[u]` entries when they come off the queue?",
        ].join("\n"),
      },
    ],
  );
  const sixPm = at(18, 0);
  const planAt = sixPm.getTime() < Date.now() ? sixPm : new Date(Date.now() - 3600e3);
  add(
    { id: crypto.randomUUID(), title: `Weekly study plan · ${fmtStamp(planAt)}`, origin: "automation", automationName: "Weekly study plan", createdAt: iso(planAt), updatedAt: iso(planAt) },
    [
      { t: iso(planAt), kind: "user", text: "Plan my study week around my classes, deadlines and exams in 45-minute blocks with breaks. Show it as a day-by-day table." },
      { t: iso(planAt), kind: "tool", toolCallId: rid("call_"), name: "m365_fetch", args: '{\n  "entityUrls": ["/me/calendarView?…", "/education/me/assignments?…"]\n}', success: true, result: "14 events · 5 assignments" },
      { t: iso(planAt), kind: "assistant", text: STUDY_PLAN },
    ],
  );
  const yesterday = new Date(Date.now() - 26 * 3600e3);
  add(
    { id: crypto.randomUUID(), title: "Summarise the Week 8 lecture on hash tables", createdAt: iso(yesterday), updatedAt: iso(yesterday) },
    [
      { t: iso(yesterday), kind: "user", text: "Summarise the ALGO2201 Week 8 lecture on hash tables into notes and practice questions." },
      { t: iso(yesterday), kind: "tool", toolCallId: rid("call_"), name: "m365_search", args: '{\n  "query": "ALGO2201 Week 8 filetype:pptx",\n  "entityTypes": ["driveItem"]\n}', success: true, result: "1. **ALGO2201 Week 8 - Hash tables.pptx**" },
      { t: iso(yesterday), kind: "tool", toolCallId: rid("call_"), name: "m365_fetch_file", args: '{\n  "path": "/drives/demo/items/demo/content",\n  "format": "pdf"\n}', success: true, result: "Saved 2,481,233 bytes (application/pdf) to C:\\Users\\alex\\Documents\\OpenScout\\Downloads\\ALGO2201 Week 8 - Hash tables.pdf" },
      {
        t: iso(yesterday),
        kind: "assistant",
        text: "**Key points**\n- A hash table maps keys to buckets with a hash function, giving average O(1) lookups.\n- Collisions are handled by chaining (lists) or open addressing (probing).\n- Keep the load factor low (≈ 0.7) and resize when it grows.\n\n**Practice questions**\n1. What happens to lookup time when every key hashes to the same bucket?\n2. Compare linear probing and chaining for deletions.\n3. Why do resizes keep insertion amortised O(1)?",
      },
    ],
  );
  const d3 = new Date(Date.now() - 3 * 86400e3);
  add(
    { id: crypto.randomUUID(), title: "Ask Dr Nguyen about the quiz date", createdAt: iso(d3), updatedAt: iso(d3) },
    [
      { t: iso(d3), kind: "user", text: "Draft an email to Dr Nguyen asking whether Quiz 5 covers Dijkstra. Don't send it yet." },
      { t: iso(d3), kind: "assistant", text: "Draft:\n\n> Dear Dr Nguyen, does Quiz 5 cover Dijkstra's algorithm, or only BFS and DFS? Thank you, Alex Chen\n\nI'll save it to your Drafts folder." },
      { t: iso(d3), kind: "permission", title: "Create an email draft", detail: "POST /me/messages", decision: "once" },
      { t: iso(d3), kind: "tool", toolCallId: rid("call_"), name: "m365_create", args: '{\n  "parentUrl": "/me/messages",\n  "jsonBody": { "subject": "Quiz 5 topics" }\n}', success: true, result: '{"statusCode":201,"data":{"isDraft":true}}' },
      { t: iso(d3), kind: "assistant", text: "Saved as a draft in Outlook — it's in your **Drafts** folder whenever you're ready to send." },
    ],
  );
  return sessions;
}

// ── Simulated server ────────────────────────────────────────────────────────

class DemoServer {
  constructor(deliver) {
    this.deliver = deliver;
    this.settings = defaultSettings();
    this.github = { state: "signed-in", login: "alexchen-edu", host: "https://github.com", authType: "user", cliLoginAvailable: false };
    this.sessions = new Map(seedSessions().map((s) => [s.meta.id, s]));
    this.turns = new Map();
    this.perms = new Map();
    this.inputs = new Map();
    this.running = new Set();
    this.runs = [];
    this.memory = [
      ["preference", "Alex studies best in 45-minute blocks with 10-minute breaks."],
      ["fact", "ALGO2201 final exam is on 18 November at 9am."],
      ["context", "Alex's HCID2300 project team (Team 7) is Mia, Leo and Priya."],
      ["preference", "Alex likes a worked example before the theory."],
    ].map(([category, fact], i) => ({ id: rid("mem_"), fact, category, source: i % 2 ? "user" : "agent", createdAt: iso(new Date(Date.now() - (i + 1) * 86400e3)) }));
    this.skills = [
      { name: "study-plan", description: "Plan my study week around classes, deadlines and exams in 45-minute blocks.", source: "openscout", editable: true, body: "1. Read my calendar and assignments for the next 7 days.\n2. Fit 45-minute study blocks with breaks around classes.\n3. Put the closest deadlines first and keep one rest day." },
      { name: "lecture-notes", description: "Turn lecture slides or transcripts into concise notes, key terms and practice questions.", source: "openscout", editable: true, body: "Summarise into key points, key terms and three practice questions with hidden answers." },
      { name: "cite-sources", description: "Format references and in-text citations in APA 7th edition.", source: "openscout", editable: true, body: "Ask for any missing details (author, year, title, publisher or URL) and format in APA 7th." },
      { name: "flashcards", description: "Make spaced-repetition flashcards from my notes.", source: "openscout", editable: true, body: "Create question-and-answer cards, one fact per card, and save them as a CSV for Anki." },
      { name: "docx", description: "Create, read and edit Word documents.", source: "copilot-cli", editable: false, body: "Use python-docx to build and edit .docx files." },
      { name: "xlsx", description: "Create and analyse Excel workbooks, tables and charts.", source: "copilot-cli", editable: false, body: "Use openpyxl to build and edit .xlsx files." },
    ];
    const planSession = [...this.sessions.values()].find((s) => s.meta.automationName === "Weekly study plan");
    this.automations = [];
    this.createAutomation(
      { name: "Weekly study plan", description: "Sunday-evening plan for the week ahead.", schedule: "every Sunday at 6pm", prompt: "Plan my study week around my classes, deadlines and exams in 45-minute blocks with breaks. Show it as a day-by-day table.", notify: { desktop: true, email: "never" } },
      { silent: true, last: { status: "ok", summary: STUDY_PLAN, sessionId: planSession?.meta.id, at: planSession?.meta.createdAt } },
    );
    this.createAutomation(
      { name: "Assignment radar", description: "Weekday-morning check for new or changed deadlines.", schedule: "every weekday at 8am", prompt: "Check my school email and Teams class posts for new or changed assignments and deadlines. List what's due in the next 7 days.", notify: { desktop: true, email: "auto" } },
      { silent: true },
    );
    this.createAutomation(
      { name: "Watch for ALGO2201 marks", trigger: "condition", condition: "an email or Teams post says ALGO2201 Assignment 1 marks have been released", checkEveryMinutes: 30, prompt: "Tell me my ALGO2201 Assignment 1 mark and summarise the feedback, with two things to improve for Assignment 2." },
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
  m365Status() {
    const s = this.settings.m365;
    const scopeGroups = SCOPE_GROUPS.map((g) => ({ ...g, enabled: s.scopeGroups.includes(g.id) }));
    if (!s.enabled) return { provider: s.provider, state: "disabled", copilotLicense: s.copilotLicense, scopeGroups, tools: [] };
    return {
      provider: s.provider,
      state: "ready",
      user: USER,
      copilotLicense: s.copilotLicense,
      scopeGroups,
      tools: CORE_TOOLS,
      ...(s.provider === "graph" ? { signInApp: s.clientId ? "Your organisation's app registration" : "Microsoft Graph Command Line Tools", clientId: s.clientId, tenant: s.tenant } : {}),
    };
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
      m365: this.m365Status(),
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
        ? "- ALGO2201 Quiz 4 closes at 5:30pm today, and you haven't started it."
        : /study plan/i.test(a.name)
          ? STUDY_PLAN
          : /radar/i.test(a.name)
            ? RADAR
            : a.trigger === "condition"
              ? "Your ALGO2201 Assignment 1 mark is out: **78/100 (Distinction)**. Feedback: clear code structure and good tests. To improve for Assignment 2: explain your complexity analysis, and handle empty inputs."
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
    if (a.notify?.desktop !== false && this.settings.notifications.desktop) this.publish("notify", { title: a.name, body: text.replace(/[*_#>|]/g, "").slice(0, 280), sessionId: s.meta.id, kind: "automation" });
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
        if (JSON.stringify(prev.m365) !== JSON.stringify(this.settings.m365)) this.publish("status.m365", this.m365Status());
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
      case "m365.refresh":
      case "m365.restart":
        return this.m365Status();

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
      case "m365.signIn":
      case "m365.signOut":
      case "workiq.acceptEula":
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
