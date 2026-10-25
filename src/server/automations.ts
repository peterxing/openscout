import type { Notifier } from "./notify.js";
import { paths } from "./paths.js";
import { describeSchedule, nextRun, parseSchedule, type ScheduleSpec } from "./schedule.js";
import type { NotifyPolicy, SettingsStore } from "./settings.js";
import { appendJsonl, Bus, errorMessage, log, newId, readJson, readJsonl, truncate, writeJson } from "./util.js";

export interface AutomationStep {
  id: string;
  label: string;
  prompt: string;
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  steps: AutomationStep[];
  trigger: "schedule" | "condition";
  /** Natural-language schedule as typed by the user (schedule triggers). */
  schedule: string;
  spec: ScheduleSpec;
  /** Natural-language condition (condition triggers); checked every `checkEveryMinutes`. */
  condition?: string;
  checkEveryMinutes?: number;
  model?: string;
  enabled: boolean;
  oneShot: boolean;
  /** When false (default) the run is read-only: writes/sends are denied. */
  allowActions: boolean;
  notify: { desktop: boolean; email: NotifyPolicy };
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: RunStatus;
  lastSummary?: string;
  lastSessionId?: string;
}

export type RunStatus = "running" | "ok" | "quiet" | "error" | "not-met";

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  trigger: "schedule" | "manual" | "condition";
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface AutomationInput {
  name?: string;
  description?: string;
  prompt?: string;
  steps?: { label?: string; prompt: string }[];
  schedule?: string;
  trigger?: "schedule" | "condition";
  condition?: string;
  checkEveryMinutes?: number;
  model?: string;
  enabled?: boolean;
  oneShot?: boolean;
  allowActions?: boolean;
  notify?: { desktop?: boolean; email?: NotifyPolicy };
}

export interface HeadlessRunner {
  isReady(): boolean;
  runHeadless(opts: {
    title: string;
    prompts: string[];
    model?: string;
    automationId: string;
    automationName: string;
    allowActions: boolean;
  }): Promise<{ sessionId: string; finalText: string }>;
  evaluateCondition(opts: { condition: string; model?: string; automationName: string }): Promise<{ met: boolean; evidence: string }>;
}

export const HEARTBEAT_ID = "heartbeat";
const QUIET = /\[\[quiet\]\]/i;
const MAX_CONCURRENT = 2;
const CATCH_UP_MS = 2 * 60 * 60 * 1000;

export class AutomationService {
  private items: Automation[];
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private heartbeatNext: Date | null = null;
  runner: HeadlessRunner | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    private readonly notifier: Notifier,
  ) {
    this.items = readJson<Automation[]>(paths.automations, []);
    const now = Date.now();
    for (const a of this.items) {
      // Missed while the app was closed: run once if recent, otherwise skip to the next slot.
      if (a.enabled && (!a.nextRunAt || now - Date.parse(a.nextRunAt) > CATCH_UP_MS)) a.nextRunAt = this.computeNext(a)?.toISOString();
    }
    this.save(false);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.startupTimer = setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
  }

  /** Recomputes cached next-run times after schedule-affecting settings (heartbeat, work hours) change. */
  reschedule(): void {
    this.heartbeatNext = null;
    for (const a of this.items) if (a.enabled && !this.running.has(a.id)) a.nextRunAt = this.computeNext(a)?.toISOString();
    this.save();
    this.publishHeartbeat();
  }

  list(): (Automation & { scheduleText: string; running: boolean })[] {
    return this.items.map((a) => ({ ...a, scheduleText: this.scheduleText(a), running: this.running.has(a.id) }));
  }

  get(id: string): Automation | undefined {
    return this.items.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase());
  }

  create(input: AutomationInput): Automation {
    const now = new Date().toISOString();
    const a: Automation = {
      id: newId("auto_"),
      name: (input.name || "Untitled automation").trim().slice(0, 120),
      description: (input.description || "").trim(),
      steps: [],
      trigger: input.trigger === "condition" ? "condition" : "schedule",
      schedule: "",
      spec: { kind: "interval", minutes: 60, offsetMinute: 0, workHoursOnly: false },
      model: input.model || undefined,
      enabled: input.enabled ?? true,
      oneShot: input.oneShot ?? false,
      allowActions: input.allowActions ?? false,
      notify: { desktop: input.notify?.desktop ?? true, email: input.notify?.email ?? "never" },
      createdAt: now,
      updatedAt: now,
    };
    this.applyInput(a, input, true);
    this.items.push(a);
    this.save();
    return a;
  }

  update(id: string, input: AutomationInput): Automation {
    const current = this.get(id);
    if (!current) throw new Error(`No automation with id or name "${id}".`);
    // Validate on a copy so a rejected update never leaves half-applied state behind.
    const next = structuredClone(current);
    this.applyInput(next, input, false);
    next.updatedAt = new Date().toISOString();
    this.items = this.items.map((x) => (x === current ? next : x));
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const a = this.get(id);
    if (!a) return false;
    this.items = this.items.filter((x) => x !== a);
    this.save();
    return true;
  }

  runs(automationId?: string, limit = 30): AutomationRun[] {
    const latest = new Map<string, AutomationRun>();
    for (const r of readJsonl<AutomationRun>(paths.automationRuns)) latest.set(r.id, r);
    return [...latest.values()]
      .filter((r) => !automationId || r.automationId === automationId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  heartbeatInfo(): { enabled: boolean; nextRunAt?: string; running: boolean } {
    const hb = this.settings.get().heartbeat;
    if (hb.enabled && !this.heartbeatNext) this.heartbeatNext = this.computeHeartbeatNext(new Date());
    return { enabled: hb.enabled, nextRunAt: hb.enabled ? this.heartbeatNext?.toISOString() : undefined, running: this.running.has(HEARTBEAT_ID) };
  }

  /** Manual "run now"; returns immediately while the run continues in the background. */
  runNow(id: string): AutomationRun {
    if (!this.runner?.isReady()) throw new Error("OpenScout isn't ready to run automations yet (GitHub Copilot is still connecting).");
    if (id === HEARTBEAT_ID) {
      if (this.running.has(HEARTBEAT_ID)) throw new Error("The heartbeat is already running.");
      return this.startHeartbeat("manual");
    }
    const a = this.get(id);
    if (!a) throw new Error(`No automation with id or name "${id}".`);
    if (this.running.has(a.id)) throw new Error(`"${a.name}" is already running.`);
    return this.startRun(a, "manual");
  }

  private applyInput(a: Automation, input: AutomationInput, isNew: boolean): void {
    if (input.name !== undefined) a.name = input.name.trim().slice(0, 120) || a.name;
    if (input.description !== undefined) a.description = input.description.trim();
    if (input.steps?.length) {
      a.steps = input.steps.filter((s) => s.prompt?.trim()).map((s, i) => ({ id: newId("step_"), label: s.label?.trim() || `Step ${i + 1}`, prompt: s.prompt.trim() }));
    } else if (input.prompt !== undefined) {
      if (a.steps.length) a.steps[0].prompt = input.prompt.trim();
      else a.steps = [{ id: newId("step_"), label: "Step 1", prompt: input.prompt.trim() }];
    }
    if (!a.steps.length || !a.steps.some((s) => s.prompt)) throw new Error("An automation needs a prompt.");
    if (input.trigger) a.trigger = input.trigger;
    if (input.model !== undefined) a.model = input.model || undefined;
    if (input.enabled !== undefined) a.enabled = input.enabled;
    if (input.allowActions !== undefined) a.allowActions = input.allowActions;
    if (input.notify) a.notify = { ...a.notify, ...input.notify };
    if (a.trigger === "condition") {
      if (input.condition !== undefined) a.condition = input.condition.trim();
      if (!a.condition) throw new Error("A condition-triggered automation needs a condition to watch for.");
      const every = [5, 15, 30, 60].includes(Number(input.checkEveryMinutes)) ? Number(input.checkEveryMinutes) : (a.checkEveryMinutes ?? 15);
      a.checkEveryMinutes = every;
      a.spec = { kind: "interval", minutes: every, offsetMinute: 0, workHoursOnly: false };
      a.schedule = `check every ${every} minutes`;
      a.oneShot = true;
    } else {
      if (input.oneShot !== undefined) a.oneShot = input.oneShot;
      if (input.schedule !== undefined || isNew) {
        if (!input.schedule?.trim()) throw new Error("A scheduled automation needs a schedule, e.g. \"every weekday at 9am\".");
        a.spec = parseSchedule(input.schedule);
        a.schedule = input.schedule.trim();
      }
    }
    a.nextRunAt = a.enabled ? this.computeNext(a)?.toISOString() : undefined;
  }

  private scheduleText(a: Automation): string {
    if (a.trigger === "condition") return `when: ${a.condition} (checked every ${a.checkEveryMinutes ?? 15} min)`;
    return describeSchedule(a.spec);
  }

  private computeNext(a: Automation, from = new Date()): Date | null {
    return nextRun(a.spec, from, this.settings.get().workHours);
  }

  private computeHeartbeatNext(from: Date): Date | null {
    const hb = this.settings.get().heartbeat;
    return nextRun({ kind: "interval", minutes: hb.intervalMinutes, offsetMinute: 0, workHoursOnly: hb.schedule === "work-hours" }, from, this.settings.get().workHours);
  }

  private async tick(): Promise<void> {
    // Wait for the runtime instead of failing due runs (which would consume their slot) during startup.
    if (!this.runner?.isReady()) return;
    const now = new Date();
    for (const a of this.items) {
      if (!a.enabled || !a.nextRunAt || this.running.has(a.id)) continue;
      if (Date.parse(a.nextRunAt) > now.getTime()) continue;
      if (this.running.size >= MAX_CONCURRENT) break;
      this.startRun(a, a.trigger === "condition" ? "condition" : "schedule");
    }
    const hb = this.settings.get().heartbeat;
    if (!hb.enabled) {
      this.heartbeatNext = null;
    } else {
      if (!this.heartbeatNext) this.heartbeatNext = this.computeHeartbeatNext(now);
      if (this.heartbeatNext && this.heartbeatNext <= now && !this.running.has(HEARTBEAT_ID) && this.running.size < MAX_CONCURRENT) {
        this.startHeartbeat("schedule");
      }
    }
  }

  private publishHeartbeat(): void {
    this.bus.publish("heartbeat", this.heartbeatInfo());
  }

  private startHeartbeat(trigger: AutomationRun["trigger"]): AutomationRun {
    const hb = this.settings.get().heartbeat;
    const pseudo: Automation = {
      id: HEARTBEAT_ID,
      name: "Heartbeat",
      description: "Periodic check-in",
      steps: [{ id: "hb", label: "Check-in", prompt: hb.prompt }],
      trigger: "schedule",
      schedule: "",
      spec: { kind: "interval", minutes: hb.intervalMinutes, offsetMinute: 0, workHoursOnly: hb.schedule === "work-hours" },
      enabled: true,
      oneShot: false,
      allowActions: false,
      notify: { desktop: true, email: hb.emailNotify },
      createdAt: "",
      updatedAt: "",
    };
    this.heartbeatNext = this.computeHeartbeatNext(new Date());
    return this.startRun(pseudo, trigger);
  }

  private startRun(a: Automation, trigger: AutomationRun["trigger"]): AutomationRun {
    const run: AutomationRun = {
      id: newId("run_"),
      automationId: a.id,
      automationName: a.name,
      trigger,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.running.add(a.id);
    if (a.id !== HEARTBEAT_ID) {
      // Advance the schedule up front so a slow run can't be triggered twice.
      a.nextRunAt = this.computeNext(a)?.toISOString();
      this.save();
    }
    this.recordRun(run);
    if (a.id === HEARTBEAT_ID) this.publishHeartbeat();
    void this.execute(a, run).finally(() => {
      this.running.delete(a.id);
      this.bus.publish("automations.changed", this.list());
      if (a.id === HEARTBEAT_ID) this.publishHeartbeat();
    });
    return run;
  }

  private async execute(a: Automation, run: AutomationRun): Promise<void> {
    const runner = this.runner;
    // A scheduled one-shot is used up once it starts; a condition is used up once it's confirmed — even if the action then fails.
    let consumed = a.oneShot && run.trigger === "schedule";
    try {
      if (!runner) throw new Error("Session runner not ready.");
      if (a.trigger === "condition" && run.trigger !== "manual") {
        const check = await runner.evaluateCondition({ condition: a.condition ?? "", model: a.model, automationName: a.name });
        if (!check.met) {
          run.status = "not-met";
          run.summary = check.evidence;
          return;
        }
        consumed = true;
      }
      const stamp = new Date().toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
      const result = await runner.runHeadless({
        title: `${a.name} · ${stamp}`,
        prompts: a.steps.map((s) => s.prompt),
        model: a.model,
        automationId: a.id,
        automationName: a.name,
        allowActions: a.allowActions,
      });
      run.sessionId = result.sessionId;
      const quiet = QUIET.test(result.finalText);
      run.status = quiet ? "quiet" : "ok";
      run.summary = truncate(result.finalText.replace(QUIET, "").trim() || "(no output)", 6000);
      if (!quiet && a.notify.desktop) {
        this.notifier.desktop({ title: a.name, body: run.summary.slice(0, 280), sessionId: run.sessionId, kind: a.id === HEARTBEAT_ID ? "heartbeat" : "automation" });
      }
      const policy = a.notify.email;
      if (policy === "always" || (policy === "auto" && !quiet)) {
        const body = quiet ? "Nothing needed your attention this time." : run.summary;
        const sent = await this.notifier.emailSelf(`[OpenScout] ${a.name}`, body);
        if (!sent.sent) log("automations", `email notification skipped for ${a.name}: ${sent.reason}`);
      }
    } catch (err) {
      run.status = "error";
      run.error = errorMessage(err);
      log("automations", `${a.name} failed:`, run.error);
      this.notifier.desktop({ title: `${a.name} failed`, body: run.error.slice(0, 280), kind: "error" });
    } finally {
      run.finishedAt = new Date().toISOString();
      this.recordRun(run);
      // The automation may have been edited (replaced) or deleted while this run was in flight.
      const cur = a.id === HEARTBEAT_ID ? undefined : this.items.find((x) => x.id === a.id);
      if (cur) {
        if (consumed) cur.enabled = false;
        cur.lastRunAt = run.startedAt;
        cur.lastStatus = run.status;
        cur.lastSummary = run.summary?.slice(0, 600) ?? run.error;
        if (run.sessionId) cur.lastSessionId = run.sessionId;
        cur.nextRunAt = cur.enabled ? this.computeNext(cur)?.toISOString() : undefined;
        this.save();
      }
    }
  }

  private recordRun(run: AutomationRun): void {
    appendJsonl(paths.automationRuns, run);
    this.bus.publish("automation.run", run);
  }

  private save(publish = true): void {
    writeJson(paths.automations, this.items);
    if (publish) this.bus.publish("automations.changed", this.list());
  }
}
