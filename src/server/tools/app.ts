import { defineTool, type Tool } from "@github/copilot-sdk";
import type { AutomationInput } from "../automations.js";
import { PERSONALITIES } from "../prompt.js";
import type { NotifyPolicy } from "../settings.js";
import type { ToolContext } from "./context.js";
import { buildM365Tools } from "./m365.js";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const bool = (description: string) => ({ type: "boolean", description });

const automationProps = {
  name: str("Short name for the automation."),
  description: str("What it does, in one sentence."),
  prompt: str("The self-contained instruction to run each time (single-step automations)."),
  steps: {
    type: "array",
    description: "Ordered steps for a multi-step automation (each runs in the same conversation). Overrides prompt.",
    items: obj({ label: str("Step label."), prompt: str("Instruction for this step.") }, ["prompt"]),
  },
  trigger: str("'schedule' (default) or 'condition'.", { enum: ["schedule", "condition"] }),
  schedule: str("For schedule triggers, in plain English: 'every weekday at 9am', 'every day at 9am, 2pm and 6pm', 'every Monday at 8:30am', 'every 30 minutes', 'every 2 hours at :15', 'every hour during work hours'."),
  condition: str("For condition triggers: what to watch for, e.g. 'an email from Contoso about the renewal has arrived'. Runs once when met."),
  checkEveryMinutes: { type: "integer", enum: [5, 15, 30, 60], description: "How often to check a condition (default 15)." },
  model: str("Optional model ID override."),
  enabled: bool("Whether the automation is active (default true)."),
  oneShot: bool("Run once, then disable."),
  allowActions: bool("Allow the unattended run to change data or send things (default false = read-only). Only set when the user explicitly asks."),
  desktopNotify: bool("Show a desktop notification with the result (default true)."),
  emailNotify: str("Email the result to the user's own mailbox: 'always', 'auto' (only when there's something worth surfacing) or 'never' (default).", {
    enum: ["always", "auto", "never"],
  }),
};

function toAutomationInput(a: Record<string, any>): AutomationInput {
  const input: AutomationInput = {
    name: a.name,
    description: a.description,
    prompt: a.prompt,
    steps: a.steps,
    trigger: a.trigger,
    schedule: a.schedule,
    condition: a.condition,
    checkEveryMinutes: a.checkEveryMinutes,
    model: a.model,
    enabled: a.enabled,
    oneShot: a.oneShot,
    allowActions: a.allowActions,
  };
  if (a.desktopNotify !== undefined || a.emailNotify !== undefined) {
    input.notify = { desktop: a.desktopNotify, email: a.emailNotify as NotifyPolicy | undefined };
    if (input.notify.desktop === undefined) delete input.notify.desktop;
    if (input.notify.email === undefined) delete input.notify.email;
  }
  return input;
}

function summarizeAutomation(a: ReturnType<ToolContext["automations"]["list"]>[number]) {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    trigger: a.trigger,
    when: a.scheduleText,
    nextRunAt: a.nextRunAt,
    lastRunAt: a.lastRunAt,
    lastStatus: a.lastStatus,
    allowActions: a.allowActions,
    notify: a.notify,
    running: a.running,
  };
}

export function buildAppTools(ctx: ToolContext): Tool<any>[] {
  const { memory, automations, skills, notifier, settings, sessions } = ctx;
  return [
    // ── Memory ────────────────────────────────────────────────────────────────
    defineTool("memory_remember", {
      description:
        "Save a durable fact, preference, decision or piece of project context about the user to long-term memory (one concise sentence). " +
        "Never store secrets, credentials, payment details, health information or government identifiers.",
      parameters: obj({ fact: str("The fact, one sentence."), category: str("Category.", { enum: ["preference", "fact", "decision", "context"] }) }, ["fact"]),
      skipPermission: true,
      handler: async (a: { fact: string; category?: string }) => {
        const m = memory.add(a.fact, a.category, "agent");
        return `Saved to memory (${m.id}).`;
      },
    }),
    defineTool("memory_recall", {
      description: "Search long-term memory for facts about a topic.",
      parameters: obj({ query: str("Keywords.") }, ["query"]),
      skipPermission: true,
      handler: async (a: { query: string }) => memory.search(a.query, 15),
    }),
    defineTool("memory_list", {
      description: "List all stored memories, newest first.",
      parameters: obj({}),
      skipPermission: true,
      handler: async () => memory.list(),
    }),
    defineTool("memory_forget", {
      description: "Delete a memory by ID.",
      parameters: obj({ id: str("Memory ID (mem_…).") }, ["id"]),
      skipPermission: true,
      handler: async (a: { id: string }) => (memory.remove(a.id) ? "Deleted." : `No memory with id ${a.id}.`),
    }),

    // ── Automations ───────────────────────────────────────────────────────────
    defineTool("automation_list", {
      description: "List the user's automations (scheduled or condition-triggered prompts) with their status and next run.",
      parameters: obj({}),
      skipPermission: true,
      handler: async () => ({ automations: automations.list().map(summarizeAutomation), heartbeat: automations.heartbeatInfo() }),
    }),
    defineTool("automation_get", {
      description: "Get an automation's full definition (including step prompts) and its recent runs.",
      parameters: obj({ id: str("Automation ID or exact name.") }, ["id"]),
      skipPermission: true,
      handler: async (a: { id: string }) => {
        const item = automations.get(a.id);
        if (!item) return `No automation "${a.id}".`;
        return { automation: item, recentRuns: automations.runs(item.id, 5).map((r) => ({ ...r, summary: r.summary?.slice(0, 400) })) };
      },
    }),
    defineTool("automation_create", {
      description:
        "Create an automation that runs a prompt on a schedule (or once a condition is met) without the user present. " +
        "Runs are read-only unless allowActions is true. Use oneShot for one-time tasks.",
      parameters: obj(automationProps, ["name"]),
      handler: async (a: Record<string, unknown>) => {
        const created = automations.create(toAutomationInput(a));
        return { created: summarizeAutomation(automations.list().find((x) => x.id === created.id)!) };
      },
    }),
    defineTool("automation_update", {
      description: "Update an automation. Only the provided fields change.",
      parameters: obj({ id: str("Automation ID or exact name."), ...automationProps }, ["id"]),
      handler: async (a: Record<string, unknown>) => {
        const updated = automations.update(String(a.id), toAutomationInput(a));
        return { updated: summarizeAutomation(automations.list().find((x) => x.id === updated.id)!) };
      },
    }),
    defineTool("automation_delete", {
      description: "Delete an automation.",
      parameters: obj({ id: str("Automation ID or exact name.") }, ["id"]),
      handler: async (a: { id: string }) => (automations.remove(a.id) ? "Deleted." : `No automation "${a.id}".`),
    }),
    defineTool("automation_run_now", {
      description: "Start an automation immediately (use id 'heartbeat' for the heartbeat). Returns at once; the result arrives as a notification.",
      parameters: obj({ id: str("Automation ID or exact name.") }, ["id"]),
      handler: async (a: { id: string }) => {
        const run = automations.runNow(a.id);
        return `Started run ${run.id} of "${run.automationName}".`;
      },
    }),

    // ── Skills ────────────────────────────────────────────────────────────────
    defineTool("skill_list", {
      description: "List available skills (reusable instruction sets) with their source and whether they're enabled.",
      parameters: obj({}),
      skipPermission: true,
      handler: async () => skills.list().map(({ name, description, source, enabled }) => ({ name, description, source, enabled })),
    }),
    defineTool("skill_save", {
      description:
        "Create or replace a user skill in OpenScout's skill folder. The description should say when to use it; instructions hold the detailed steps (Markdown). " +
        "The user can then invoke it with /name.",
      parameters: obj(
        { name: str("lowercase-hyphenated name"), description: str("When to use this skill."), instructions: str("Detailed Markdown instructions.") },
        ["name", "description", "instructions"],
      ),
      handler: async (a: { name: string; description: string; instructions: string }) => {
        const s = skills.save(a);
        return `Saved skill "${s.name}" to ${s.dir}. It will be available in new conversations.`;
      },
    }),

    // ── Notifications ────────────────────────────────────────────────────────
    defineTool("notify_user", {
      description: "Show a desktop notification to the user (e.g. when a long task finishes).",
      parameters: obj({ title: str("Short title."), message: str("One or two sentences.") }, ["title", "message"]),
      skipPermission: true,
      handler: async (a: { title: string; message: string }, inv) => {
        notifier.desktop({ title: a.title, body: a.message, sessionId: inv.sessionId, kind: "info" });
        return "Notification shown.";
      },
    }),
    defineTool("email_me", {
      description: "Email a short Markdown summary to the user's own mailbox (only to them) via Microsoft 365. Useful for reminders and long-running results.",
      parameters: obj({ subject: str("Subject line."), body: str("Markdown body.") }, ["subject", "body"]),
      skipPermission: true,
      handler: async (a: { subject: string; body: string }) => {
        const r = await notifier.emailSelf(a.subject, a.body);
        return r.sent ? "Email sent to the user's mailbox." : `Not sent: ${r.reason}`;
      },
    }),

    // ── App settings & history ──────────────────────────────────────────────
    defineTool("app_get_settings", {
      description: "Read OpenScout's settings (theme, default model, personality, heartbeat, notifications, Microsoft 365 and browser options, permission mode).",
      parameters: obj({}),
      skipPermission: true,
      handler: async () => ({ settings: settings.get(), personalities: PERSONALITIES.map(({ id, name, description }) => ({ id, name, description })) }),
    }),
    defineTool("app_update_settings", {
      description:
        "Change OpenScout settings the user asked to change: theme, default model, personality, heartbeat and notifications. " +
        "Permission settings can only be changed by the user in the Settings page.",
      parameters: obj({
        theme: str("Theme.", { enum: ["system", "light", "dark"] }),
        defaultModel: str("Default model ID for new conversations."),
        personality: str("Personality ID.", { enum: PERSONALITIES.map((p) => p.id) }),
        heartbeat: obj({
          enabled: bool("Enable the periodic heartbeat check-in."),
          intervalMinutes: { type: "integer", enum: [15, 30, 60, 120] },
          schedule: str("When to run.", { enum: ["work-hours", "always"] }),
          prompt: str("What the heartbeat should check."),
          emailNotify: str("Email results.", { enum: ["always", "auto", "never"] }),
        }),
        notifications: obj({ desktop: bool("Desktop notifications."), email: bool("Allow email-to-self notifications.") }),
      }),
      handler: async (a: Record<string, unknown>) => {
        const allowed: Record<string, unknown> = {};
        for (const k of ["theme", "defaultModel", "personality", "heartbeat", "notifications"]) if (a[k] !== undefined) allowed[k] = a[k];
        const s = settings.update(allowed);
        return { updated: Object.keys(allowed), settings: { theme: s.theme, defaultModel: s.defaultModel, personality: s.personality, heartbeat: s.heartbeat, notifications: s.notifications } };
      },
    }),
    defineTool("session_search", {
      description: "Search past OpenScout conversations by keyword. Returns matching sessions with snippets.",
      parameters: obj({ query: str("Keywords.") }, ["query"]),
      skipPermission: true,
      handler: async (a: { query: string }) => sessions.search(a.query, 10),
    }),
    defineTool("session_transcript", {
      description: "Get the transcript of a past OpenScout conversation by session ID (last N entries).",
      parameters: obj({ sessionId: str("Session ID."), lastN: { type: "integer", minimum: 1, maximum: 200, description: "Entries to return (default 40)." } }, ["sessionId"]),
      skipPermission: true,
      handler: async (a: { sessionId: string; lastN?: number }) => sessions.transcriptText(a.sessionId, a.lastN ?? 40),
    }),
  ];
}

/** Tools that change OpenScout's own state; withheld from read-only automation runs so injected content can't persist itself. */
const MUTATING_APP_TOOLS = new Set([
  "memory_remember",
  "memory_forget",
  "automation_create",
  "automation_update",
  "automation_delete",
  "automation_run_now",
  "skill_save",
  "app_update_settings",
]);

export function buildTools(ctx: ToolContext, opts: { readOnlyAutomation?: boolean } = {}): Tool<any>[] {
  const app = buildAppTools(ctx).filter((t) => !(opts.readOnlyAutomation && MUTATING_APP_TOOLS.has(t.name)));
  return [...app, ...buildM365Tools(ctx)];
}
