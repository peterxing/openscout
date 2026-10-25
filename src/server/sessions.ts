import crypto from "node:crypto";
import path from "node:path";
import type {
  CopilotSession,
  MCPServerConfig,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import type { HeadlessRunner } from "./automations.js";
import type { CopilotService } from "./copilot.js";
import type { MemoryStore } from "./memory.js";
import { NODE_MODULES, paths } from "./paths.js";
import { shellAllowed, summarizePermission, type PermissionSummary } from "./permissions.js";
import { buildSystemMessage, formatNow } from "./prompt.js";
import type { SettingsStore } from "./settings.js";
import type { SkillStore } from "./skills.js";
import { buildTools } from "./tools/app.js";
import type { SessionLookup, ToolContext } from "./tools/context.js";
import type { TranscriptEntry, TranscriptStore } from "./transcripts.js";
import { Bus, errorMessage, log, newId, readJson, truncate, writeJson } from "./util.js";
import type { WorkIqService } from "./workiq.js";

export type Origin = "chat" | "automation";

type UserInputHandler = NonNullable<ResumeSessionConfig["onUserInputRequest"]>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;
type SdkAttachment = NonNullable<MessageOptions["attachments"]>[number];

export interface SessionMeta {
  id: string;
  title: string;
  titleSource: "auto" | "user" | "runtime";
  createdAt: string;
  updatedAt: string;
  model: string;
  origin: Origin;
  automationId?: string;
  automationName?: string;
  preview?: string;
  hidden?: boolean;
  usage?: { currentTokens: number; tokenLimit: number };
}

export interface Attachment {
  type: "file" | "blob";
  path?: string;
  data?: string;
  mimeType?: string;
  name?: string;
}

export type PermissionDecision = { decision: "once" | "session" | "deny"; feedback?: string };

interface LiveSession {
  id: string;
  session: CopilotSession | null;
  origin: Origin;
  allowActions: boolean;
  automationName?: string;
  busy: boolean;
  lastUsed: number;
  approvals: Set<string>;
  tools: Map<string, { name: string; args: string; server?: string }>;
}

interface PendingPermission {
  id: string;
  sessionId: string;
  summary: PermissionSummary;
  createdAt: string;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

interface PendingInput {
  id: string;
  sessionId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  createdAt: string;
  resolve: (r: UserInputResponse) => void;
  timer: NodeJS.Timeout;
}

const PROMPT_TIMEOUT_MS = 30 * 60_000;
const MAX_LIVE = 8;
const HIDDEN_TOOLS = new Set(["report_intent", "think", "ask_user"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeTitle(prompt: string): string {
  const line = prompt
    .replace(/^[#>\s*-]+/gm, "")
    .replace(/[*`]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "New conversation";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

const isConnectionError = (err: unknown) =>
  /(connection|disposed|closed|not running|EPIPE|write after end|ECONNRESET|runtime exited)/i.test(errorMessage(err));

export class SessionManager implements SessionLookup, HeadlessRunner {
  private index: Record<string, SessionMeta>;
  private live = new Map<string, LiveSession>();
  private resuming = new Map<string, Promise<LiveSession>>();
  private deleting = new Set<string>();
  private perms = new Map<string, PendingPermission>();
  private inputs = new Map<string, PendingInput>();
  toolContext: ToolContext | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    private readonly copilot: CopilotService,
    private readonly workiq: WorkIqService,
    private readonly memory: MemoryStore,
    private readonly skills: SkillStore,
    private readonly transcripts: TranscriptStore,
  ) {
    this.index = readJson<Record<string, SessionMeta>>(paths.sessions, {});
    this.bus.on("copilot.restarted", () => this.dropAllLive());
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  list(): (SessionMeta & { busy: boolean; pending: number })[] {
    return Object.values(this.index)
      .filter((m) => !m.hidden)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((m) => ({ ...m, busy: Boolean(this.live.get(m.id)?.busy), pending: this.pendingFor(m.id).length }));
  }

  get(id: string): SessionMeta | undefined {
    return this.index[id];
  }

  open(id: string): { meta: SessionMeta; transcript: TranscriptEntry[]; pending: unknown[]; busy: boolean } {
    const meta = this.index[id];
    if (!meta) throw new Error("Conversation not found.");
    return { meta, transcript: this.transcripts.read(id), pending: this.pendingFor(id), busy: Boolean(this.live.get(id)?.busy) };
  }

  pendingFor(sessionId?: string): unknown[] {
    const out: unknown[] = [];
    for (const p of this.perms.values())
      if (!sessionId || p.sessionId === sessionId) out.push({ ...p.summary, type: "permission", permissionKind: p.summary.kind, requestId: p.id, sessionId: p.sessionId });
    for (const p of this.inputs.values())
      if (!sessionId || p.sessionId === sessionId)
        out.push({ type: "input", requestId: p.id, sessionId: p.sessionId, question: p.question, choices: p.choices, allowFreeform: p.allowFreeform });
    return out;
  }

  search(query: string, limit = 20): { sessionId: string; title: string; updatedAt: string; snippet: string }[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const hits: { sessionId: string; title: string; updatedAt: string; snippet: string }[] = [];
    for (const meta of this.list()) {
      const titleHit = terms.every((t) => meta.title.toLowerCase().includes(t));
      let snippet = "";
      for (const e of this.transcripts.read(meta.id)) {
        const text = e.kind === "user" || e.kind === "assistant" ? e.text : "";
        const lower = text.toLowerCase();
        if (text && terms.every((t) => lower.includes(t))) {
          const at = Math.max(0, lower.indexOf(terms[0]) - 60);
          snippet = `${at > 0 ? "…" : ""}${text.slice(at, at + 200).replace(/\s+/g, " ")}…`;
          break;
        }
      }
      if (titleHit || snippet) hits.push({ sessionId: meta.id, title: meta.title, updatedAt: meta.updatedAt, snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  transcriptText(sessionId: string, lastN = 40): string {
    if (!this.index[sessionId]) return `No conversation with id ${sessionId}.`;
    return this.transcripts.asText(sessionId, lastN);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private mcpServers(): Record<string, MCPServerConfig> {
    const s = this.settings.get();
    const servers: Record<string, MCPServerConfig> = {};
    if (s.browser.enabled) {
      const inElectron = Boolean(process.versions.electron);
      servers.playwright = {
        type: "local",
        command: process.execPath,
        args: [
          path.join(NODE_MODULES, "@playwright", "mcp", "cli.js"),
          "--browser",
          s.browser.channel,
          "--user-data-dir",
          paths.browserProfile,
          "--output-dir",
          paths.browserOutput,
          ...(s.browser.headless ? ["--headless"] : []),
        ],
        env: inElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
        tools: ["*"],
        timeout: 180_000,
      };
    }
    return servers;
  }

  private async buildConfig(live: LiveSession, model: string): Promise<ResumeSessionConfig> {
    if (!this.toolContext) throw new Error("Tool context not initialised.");
    await this.workiq.whenSettled(15_000);
    const s = this.settings.get();
    const skills = this.skills.list();
    const info = this.copilot.models.find((m) => m.id === model);
    const effort = s.reasoningEffort && info?.capabilities?.supports?.reasoningEffort ? s.reasoningEffort : undefined;
    return {
      clientName: "OpenScout",
      model: model || undefined,
      ...(effort ? { reasoningEffort: effort } : {}),
      streaming: true,
      workingDirectory: s.workingDirectory,
      systemMessage: buildSystemMessage({
        settings: s,
        memory: this.memory,
        skills,
        workiq: this.workiq.status,
        origin: live.origin,
        automationName: live.automationName,
        automationReadOnly: !live.allowActions,
      }),
      tools: buildTools(this.toolContext, { readOnlyAutomation: live.origin === "automation" && !live.allowActions }),
      mcpServers: this.mcpServers(),
      disabledMcpServers: s.github.mcpEnabled ? [] : ["github-mcp-server"],
      skillDirectories: this.skills.roots().map((r) => r.dir),
      disabledSkills: s.disabledSkills,
      interactiveUser: live.origin === "chat",
      onPermissionRequest: (req, inv) => this.onPermission(live, req, inv),
      onUserInputRequest: (req) => this.onUserInput(live, req),
      hooks: {
        onUserPromptSubmitted: async () => ({
          additionalContext: `<current_datetime>${formatNow(this.settings.get().timezone)}</current_datetime>`,
        }),
      },
      onEvent: (e) => this.handleEvent(live, e),
    };
  }

  private newLive(id: string, origin: Origin, allowActions: boolean, automationName?: string): LiveSession {
    return { id, session: null, origin, allowActions, automationName, busy: false, lastUsed: Date.now(), approvals: new Set(), tools: new Map() };
  }

  private requireSignedIn(): void {
    if (this.copilot.status.state !== "signed-in") {
      throw new Error("GitHub Copilot isn't signed in yet. Open Settings → Accounts to connect your GitHub Copilot account.");
    }
  }

  /** Used by the scheduler so runs wait for the runtime instead of failing (and losing their slot) at startup. */
  isReady(): boolean {
    return this.copilot.status.state === "signed-in" && this.copilot.client !== null && this.toolContext !== null;
  }

  async create(opts: {
    origin: Origin;
    id?: string;
    model?: string;
    title?: string;
    automationId?: string;
    automationName?: string;
    allowActions?: boolean;
    hidden?: boolean;
  }): Promise<LiveSession> {
    this.requireSignedIn();
    const client = this.copilot.requireClient();
    let id: string;
    if (opts.id !== undefined) {
      // The UI picks the ID up front so it can route events; never silently substitute another one.
      if (!UUID_RE.test(opts.id) || this.index[opts.id] || this.live.has(opts.id) || this.resuming.has(opts.id) || this.deleting.has(opts.id)) {
        throw new Error("Invalid or duplicate conversation id.");
      }
      id = opts.id;
    } else {
      id = crypto.randomUUID();
    }
    const model = opts.model || this.settings.get().defaultModel || "auto";
    const live = this.newLive(id, opts.origin, opts.allowActions ?? false, opts.automationName);
    this.live.set(id, live);
    try {
      const cfg = await this.buildConfig(live, model);
      live.session = await client.createSession({ ...cfg, sessionId: id });
    } catch (err) {
      this.live.delete(id);
      throw err;
    }
    const now = new Date().toISOString();
    this.index[id] = {
      id,
      title: opts.title || "New conversation",
      titleSource: opts.title ? "user" : "auto",
      createdAt: now,
      updatedAt: now,
      model,
      origin: opts.origin,
      automationId: opts.automationId,
      automationName: opts.automationName,
      hidden: opts.hidden,
    };
    this.saveIndex();
    this.evictIdle(id);
    return live;
  }

  /** Returns a live session, resuming it from disk when needed. Resumed sessions are interactive. */
  async ensureLive(id: string): Promise<LiveSession> {
    if (this.deleting.has(id)) throw new Error("This conversation is being deleted.");
    const existing = this.live.get(id);
    if (existing?.session) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const inflight = this.resuming.get(id);
    if (inflight) return inflight;
    const meta = this.index[id];
    if (!meta) throw new Error("Conversation not found.");
    this.requireSignedIn();
    const p = (async () => {
      const live = this.newLive(id, "chat", false);
      this.live.set(id, live);
      try {
        const cfg = await this.buildConfig(live, meta.model);
        live.session = await this.copilot.requireClient().resumeSession(id, cfg);
      } catch (err) {
        this.live.delete(id);
        throw err;
      }
      if (this.deleting.has(id) || !this.index[id]) {
        // Deleted while resuming: don't hand back an orphaned handle.
        this.live.delete(id);
        await live.session.disconnect().catch(() => undefined);
        throw new Error("This conversation was deleted.");
      }
      this.evictIdle(id);
      return live;
    })();
    this.resuming.set(id, p);
    try {
      return await p;
    } finally {
      this.resuming.delete(id);
    }
  }

  /** Disconnects least-recently-used idle chat sessions beyond MAX_LIVE (never `keepId`, which a caller is about to use). */
  private evictIdle(keepId?: string): void {
    const idle = [...this.live.values()]
      .filter((l) => !l.busy && l.session && l.id !== keepId && l.origin !== "automation")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.live.size > MAX_LIVE && idle.length) {
      const victim = idle.shift()!;
      void this.release(victim.id);
    }
  }

  private async release(id: string): Promise<void> {
    this.clearPending(id, "The conversation was closed.");
    const live = this.live.get(id);
    this.live.delete(id);
    if (live?.session) await live.session.disconnect().catch(() => undefined);
  }

  /** Settles every pending approval/question for a session (or all sessions) so no promise or timer outlives it. */
  private clearPending(sessionId: string | null, reason: string): void {
    for (const p of [...this.perms.values()]) if (!sessionId || p.sessionId === sessionId) this.resolvePermission(p.id, { decision: "deny", feedback: reason });
    for (const p of [...this.inputs.values()]) if (!sessionId || p.sessionId === sessionId) this.resolveInput(p.id, reason, true);
  }

  /** Called when the runtime restarts: every live session handle and pending prompt is stale. */
  dropAllLive(): void {
    this.clearPending(null, "The assistant runtime restarted.");
    for (const l of this.live.values()) {
      if (l.busy) this.emit(l.id, { kind: "idle" });
      l.busy = false;
    }
    this.live.clear();
    this.publishList();
  }

  async send(input: { sessionId?: string; isNew?: boolean; prompt: string; attachments?: Attachment[]; model?: string }): Promise<string> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("Message is empty.");
    const open = () =>
      input.sessionId && !input.isNew
        ? this.ensureLive(input.sessionId)
        : this.create({ origin: "chat", model: input.model, id: input.isNew ? input.sessionId : undefined });
    let live: LiveSession;
    try {
      live = await open();
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      log("sessions", "runtime connection lost; restarting");
      await this.copilot.restart();
      live = await open();
    }
    const meta = this.index[live.id];
    if (!meta || this.deleting.has(live.id)) throw new Error("This conversation was deleted.");
    if (live.busy) throw new Error("OpenScout is still working on the previous message. Wait for it to finish or press Stop.");
    live.busy = true;
    try {
      if (input.model && input.model !== meta.model && live.session) {
        await live.session.setModel(input.model);
        meta.model = input.model;
      }
      if (meta.titleSource === "auto" && !meta.preview) meta.title = makeTitle(prompt);
      meta.preview = prompt.slice(0, 160);
      meta.updatedAt = new Date().toISOString();
      this.saveIndex();

      const names = (input.attachments ?? []).map((a) => a.name || (a.path ? path.basename(a.path) : "attachment"));
      this.transcripts.append(live.id, { t: meta.updatedAt, kind: "user", text: prompt, ...(names.length ? { attachments: names } : {}) });
      this.emit(live.id, { kind: "user", text: prompt, attachments: names });
      live.lastUsed = Date.now();
      this.publishList();
      await live.session!.send({ prompt: this.expandSkillCommand(prompt), attachments: this.toSdkAttachments(input.attachments) });
    } catch (err) {
      live.busy = false;
      this.publishList();
      throw err;
    }
    return live.id;
  }

  private toSdkAttachments(atts?: Attachment[]): SdkAttachment[] | undefined {
    if (!atts?.length) return undefined;
    const out: SdkAttachment[] = [];
    for (const a of atts) {
      if (a.type === "file" && a.path) out.push({ type: "file", path: a.path, displayName: a.name });
      else if (a.type === "blob" && a.data && a.mimeType) out.push({ type: "blob", data: a.data, mimeType: a.mimeType, displayName: a.name });
    }
    return out.length ? out : undefined;
  }

  /** "/skill-name do X" → explicit instruction to load that skill first. */
  private expandSkillCommand(prompt: string): string {
    const m = /^\/([a-z0-9][a-z0-9-]*)\b\s*([\s\S]*)$/i.exec(prompt);
    if (!m) return prompt;
    const skill = this.skills.list().find((s) => s.name.toLowerCase() === m[1].toLowerCase() && s.enabled);
    if (!skill) return prompt;
    return `Use the "${skill.name}" skill for this request: load it with the skill tool first, then follow it.\n\n${m[2] || "(No further details — ask me what I need if the skill requires input.)"}`;
  }

  async abort(id: string): Promise<void> {
    // Settle prompts first so nothing waits on a request whose turn is being cancelled, even if abort fails.
    this.clearPending(id, "The user stopped the request.");
    const live = this.live.get(id);
    if (!live?.session) return;
    await live.session.abort();
  }

  async delete(id: string): Promise<void> {
    if (this.deleting.has(id)) return;
    this.deleting.add(id);
    try {
      this.clearPending(id, "The conversation was deleted.");
      await this.resuming.get(id)?.catch(() => undefined);
      await this.abort(id).catch(() => undefined);
      await this.release(id);
      try {
        await this.copilot.client?.deleteSession(id);
      } catch {
        // Session may never have been persisted by the runtime.
      }
      this.transcripts.remove(id);
      delete this.index[id];
      this.saveIndex();
    } finally {
      this.deleting.delete(id);
    }
  }

  rename(id: string, title: string): void {
    const meta = this.index[id];
    if (!meta) throw new Error("Conversation not found.");
    meta.title = title.trim().slice(0, 120) || meta.title;
    meta.titleSource = "user";
    this.saveIndex();
  }

  async setModel(id: string, model: string): Promise<void> {
    const meta = this.index[id];
    if (!meta) throw new Error("Conversation not found.");
    meta.model = model;
    const live = this.live.get(id);
    if (live?.session) await live.session.setModel(model);
    this.saveIndex();
  }

  async prune(retentionDays: number): Promise<number> {
    if (!retentionDays) return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const old = Object.values(this.index).filter((m) => Date.parse(m.updatedAt) < cutoff);
    for (const m of old) await this.delete(m.id).catch((err) => log("sessions", `prune ${m.id} failed:`, errorMessage(err)));
    return old.length;
  }

  // ── Headless runs (automations) ─────────────────────────────────────────

  async runHeadless(opts: { title: string; prompts: string[]; model?: string; automationId: string; automationName: string; allowActions: boolean }): Promise<{ sessionId: string; finalText: string }> {
    const live = await this.create({
      origin: "automation",
      model: opts.model,
      title: opts.title,
      automationId: opts.automationId,
      automationName: opts.automationName,
      allowActions: opts.allowActions,
    });
    live.busy = true;
    let finalText = "";
    try {
      for (const prompt of opts.prompts) {
        const t = new Date().toISOString();
        this.transcripts.append(live.id, { t, kind: "user", text: prompt });
        this.emit(live.id, { kind: "user", text: prompt, attachments: [] });
        const meta = this.index[live.id];
        if (!meta) throw new Error("The automation conversation was deleted.");
        meta.preview = prompt.slice(0, 160);
        meta.updatedAt = t;
        this.saveIndex();
        const res = await live.session!.sendAndWait({ prompt }, 20 * 60_000);
        finalText = res?.data?.content ?? finalText;
      }
    } finally {
      live.busy = false;
      this.publishList();
      await this.release(live.id);
    }
    return { sessionId: live.id, finalText };
  }

  async evaluateCondition(opts: { condition: string; model?: string; automationName: string }): Promise<{ met: boolean; evidence: string }> {
    const live = await this.create({ origin: "automation", model: opts.model, title: `Condition check · ${opts.automationName}`, automationName: opts.automationName, hidden: true });
    const ask =
      `Check whether this condition is true right now, using your tools to look (read-only):\n"${opts.condition}"\n` +
      `Be strict: only say it is met when you found concrete evidence.`;
    live.busy = true;
    try {
      try {
        const res = await live.session!.sendAndWait(
          {
            prompt: ask,
            responseSchema: {
              type: "object",
              properties: { met: { type: "boolean" }, evidence: { type: "string" } },
              required: ["met", "evidence"],
              additionalProperties: false,
            },
          },
          10 * 60_000,
        );
        const parsed = JSON.parse(res?.data?.content ?? "{}");
        return { met: parsed.met === true, evidence: String(parsed.evidence ?? "") };
      } catch {
        const res = await live.session!.sendAndWait({ prompt: `${ask}\nAnswer with MET or NOT MET on the first line, then one line of evidence.` }, 10 * 60_000);
        const text = res?.data?.content ?? "";
        return { met: /^\s*MET\b/i.test(text), evidence: text.split(/\r?\n/).slice(1).join(" ").trim() };
      }
    } finally {
      live.busy = false;
      await this.delete(live.id);
    }
  }

  // ── Permissions & questions ──────────────────────────────────────────────

  private async onPermission(live: LiveSession, req: PermissionRequest, inv?: { promptRequest?: unknown }): Promise<PermissionRequestResult> {
    const s = this.settings.get();
    const automations = this.toolContext?.automations;
    const summary = summarizePermission(req, this.workiq, {
      automationAllowsActions: (idOrName) => automations?.get(idOrName)?.allowActions,
    });
    // Organisation-managed policy can require a human for this request: never auto-approve it.
    const managed = (inv?.promptRequest as { managedApprovalRequired?: boolean } | undefined)?.managedApprovalRequired ?? (req as { managedApprovalRequired?: boolean }).managedApprovalRequired;
    if (live.origin === "automation") {
      if (managed) return { kind: "user-not-available" };
      // Even action-enabled runs may not mint or launch other privileged automations.
      if (summary.risk === "high" && /^automation_/.test(summary.toolName ?? "")) {
        return { kind: "reject", feedback: "Unattended runs can't create, escalate or start automations that are allowed to take actions." };
      }
      if (live.allowActions || summary.readOnly || shellAllowed(req, s.permissions.shellAllow)) return { kind: "approve-once" };
      return {
        kind: "reject",
        feedback:
          "This automation run is read-only, so actions that change data or send anything are blocked. Use the view/glob/grep tools to read local files, and describe or draft any action in your reply instead.",
      };
    }
    if (!managed) {
      if (s.permissions.mode === "allow-all") return { kind: "approve-once" };
      if (live.approvals.has(summary.key)) return { kind: "approve-once" };
      if (s.permissions.mode === "auto-read" && summary.readOnly) return { kind: "approve-once" };
      if (shellAllowed(req, s.permissions.shellAllow)) return { kind: "approve-once" };
    }

    const decision = await this.askPermission(live.id, managed ? { ...summary, allowSession: false } : summary);
    this.transcripts.append(live.id, {
      t: new Date().toISOString(),
      kind: "permission",
      title: summary.title,
      detail: truncate(summary.detail, 1500),
      decision: decision.decision,
    });
    if (decision.decision === "deny") return { kind: "reject", feedback: decision.feedback || "The user declined this action." };
    if (decision.decision === "session" && summary.allowSession && !managed) live.approvals.add(summary.key);
    return { kind: "approve-once" };
  }

  private askPermission(sessionId: string, summary: PermissionSummary): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const id = newId("perm_");
      const timer = setTimeout(() => this.resolvePermission(id, { decision: "deny", feedback: "No response from the user in time." }), PROMPT_TIMEOUT_MS);
      this.perms.set(id, { id, sessionId, summary, createdAt: new Date().toISOString(), resolve, timer });
      this.emit(sessionId, { ...summary, kind: "permission.request", permissionKind: summary.kind, requestId: id });
      this.publishList();
      this.bus.publish("attention", { sessionId, kind: "permission", title: summary.title });
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const p = this.perms.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.perms.delete(requestId);
    p.resolve(decision);
    this.emit(p.sessionId, { kind: "permission.resolved", requestId, decision: decision.decision });
    this.publishList();
    return true;
  }

  private async onUserInput(live: LiveSession, req: UserInputRequest): Promise<UserInputResponse> {
    if (live.origin === "automation") {
      return { answer: "The user isn't available during an unattended automation run. Make a sensible assumption, note it, and continue.", wasFreeform: true };
    }
    const answer = await new Promise<UserInputResponse>((resolve) => {
      const id = newId("ask_");
      const timer = setTimeout(() => this.resolveInput(id, "No answer from the user in time.", true), PROMPT_TIMEOUT_MS);
      this.inputs.set(id, {
        id,
        sessionId: live.id,
        question: req.question,
        choices: req.choices,
        allowFreeform: req.allowFreeform !== false,
        createdAt: new Date().toISOString(),
        resolve,
        timer,
      });
      this.emit(live.id, { kind: "input.request", requestId: id, question: req.question, choices: req.choices ?? [], allowFreeform: req.allowFreeform !== false });
      this.publishList();
      this.bus.publish("attention", { sessionId: live.id, kind: "question", title: req.question });
    });
    this.transcripts.append(live.id, { t: new Date().toISOString(), kind: "input", question: req.question, answer: answer.answer });
    return answer;
  }

  resolveInput(requestId: string, answer: string, wasFreeform: boolean): boolean {
    const p = this.inputs.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.inputs.delete(requestId);
    p.resolve({ answer, wasFreeform });
    this.emit(p.sessionId, { kind: "input.resolved", requestId, answer });
    this.publishList();
    return true;
  }

  // ── Runtime events → UI + transcript ─────────────────────────────────────

  private handleEvent(live: LiveSession, e: SessionEvent): void {
    const id = live.id;
    const ev = e as any;
    const sub = Boolean(ev.agentId);
    switch (e.type) {
      case "assistant.message_delta":
        if (!sub && ev.data.deltaContent) this.emit(id, { kind: "assistant.delta", messageId: ev.data.messageId, delta: ev.data.deltaContent });
        break;
      case "assistant.message": {
        if (sub) break;
        const text = String(ev.data.content ?? "");
        this.emit(id, { kind: "assistant.message", messageId: ev.data.messageId, text });
        if (text.trim()) {
          this.transcripts.append(id, { t: e.timestamp, kind: "assistant", text, messageId: ev.data.messageId });
          const meta = this.index[id];
          if (meta) {
            meta.updatedAt = new Date().toISOString();
            this.saveIndex(false);
          }
        }
        break;
      }
      case "assistant.reasoning_delta":
        if (!sub) this.emit(id, { kind: "reasoning.delta", reasoningId: ev.data.reasoningId, delta: ev.data.deltaContent });
        break;
      case "assistant.intent":
        if (!sub) this.emit(id, { kind: "intent", intent: ev.data.intent });
        break;
      case "tool.execution_start": {
        if (sub || HIDDEN_TOOLS.has(ev.data.toolName)) break;
        const args = truncate(typeof ev.data.arguments === "string" ? ev.data.arguments : JSON.stringify(ev.data.arguments ?? {}, null, 2), 4000);
        live.tools.set(ev.data.toolCallId, { name: ev.data.toolName, args, server: ev.data.mcpServerName });
        this.emit(id, { kind: "tool.start", toolCallId: ev.data.toolCallId, name: ev.data.toolName, title: ev.data.toolTitle, server: ev.data.mcpServerName, args });
        break;
      }
      case "tool.execution_complete": {
        const started = live.tools.get(ev.data.toolCallId);
        if (!started) break;
        live.tools.delete(ev.data.toolCallId);
        const raw = ev.data.result?.detailedContent ?? ev.data.result?.content ?? ev.data.error?.message ?? "";
        const result = truncate(String(raw), 6000);
        this.emit(id, { kind: "tool.complete", toolCallId: ev.data.toolCallId, success: ev.data.success, result });
        this.transcripts.append(id, {
          t: e.timestamp,
          kind: "tool",
          toolCallId: ev.data.toolCallId,
          name: started.name,
          server: started.server,
          args: truncate(started.args, 1500),
          success: ev.data.success,
          result: truncate(result, 1500),
        });
        break;
      }
      case "subagent.started":
        this.emit(id, { kind: "info", text: `Started sub-agent: ${ev.data.agentDisplayName || ev.data.agentName}` });
        break;
      case "session.compaction_start":
        this.emit(id, { kind: "info", text: "Compacting conversation history…" });
        break;
      case "session.usage_info": {
        const meta = this.index[id];
        if (meta && !sub) {
          meta.usage = { currentTokens: ev.data.currentTokens, tokenLimit: ev.data.tokenLimit };
          this.emit(id, { kind: "usage", ...meta.usage });
        }
        break;
      }
      case "session.title_changed": {
        const meta = this.index[id];
        const title = String(ev.data.title ?? "").trim();
        if (meta && meta.titleSource !== "user" && title && title.length <= 80) {
          meta.title = title;
          meta.titleSource = "runtime";
          this.saveIndex();
        }
        break;
      }
      case "session.error":
        if (sub) break;
        this.transcripts.append(id, { t: e.timestamp, kind: "error", text: String(ev.data.message ?? "Unknown error") });
        this.emit(id, { kind: "error", text: String(ev.data.message ?? "Unknown error"), errorType: ev.data.errorType });
        break;
      case "abort":
        this.emit(id, { kind: "info", text: "Stopped." });
        break;
      case "session.idle":
        // Sub-agents finishing must not unlock the root turn.
        if (sub) break;
        live.busy = false;
        live.lastUsed = Date.now();
        live.tools.clear();
        this.emit(id, { kind: "idle" });
        this.publishList();
        break;
      default:
        break;
    }
  }

  private emit(sessionId: string, payload: Record<string, unknown>): void {
    this.bus.publish("session.event", { sessionId, ...payload });
  }

  private publishList(): void {
    this.bus.publish("sessions", this.list());
  }

  private saveIndex(publish = true): void {
    writeJson(paths.sessions, this.index);
    if (publish) this.publishList();
  }
}
