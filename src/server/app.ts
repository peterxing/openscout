import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AutomationService } from "./automations.js";
import { CopilotService } from "./copilot.js";
import { GraphService } from "./graph.js";
import { HttpServer, type ClientContext } from "./http.js";
import { M365Service } from "./m365.js";
import { MemoryStore } from "./memory.js";
import { Notifier } from "./notify.js";
import { APP_NAME, APP_VERSION, ensureDataDirs, paths } from "./paths.js";
import { PERSONALITIES } from "./prompt.js";
import { describeSchedule, nextRun, parseSchedule } from "./schedule.js";
import { SessionManager, type PermissionDecision } from "./sessions.js";
import { SettingsStore, type Settings } from "./settings.js";
import { SkillStore } from "./skills.js";
import { TranscriptStore } from "./transcripts.js";
import { Bus, errorMessage, log } from "./util.js";
import { WorkIqService } from "./workiq.js";

export interface HostHooks {
  /** Opens a file or folder with the OS default handler (Electron passes shell.openPath). */
  openPath?: (p: string) => Promise<string | void>;
  /** Selects a file in Explorer/Finder without opening it. */
  showItemInFolder?: (p: string) => void;
  openExternal?: (url: string) => Promise<void>;
  host: "electron" | "web";
}

/** File types that run code when "opened"; links to these are revealed in Explorer instead. */
const RISKY_EXT =
  /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|mjs|wsf|wsh|msi|msp|msix|appx|lnk|scr|hta|cpl|reg|jar|url|appref-ms|pif|application|gadget|msc|inf|scf|sys|dll|ocx|settingcontent-ms|library-ms|website|xll|xlam|ppam|docm|xlsm|pptm)$/i;

type Params = Record<string, any>;

export class OpenScoutApp {
  readonly bus = new Bus();
  readonly token = crypto.randomBytes(24).toString("hex");
  readonly settings: SettingsStore;
  readonly copilot: CopilotService;
  readonly workiq: WorkIqService;
  readonly graph: GraphService;
  readonly m365: M365Service;
  readonly memory: MemoryStore;
  readonly skills: SkillStore;
  readonly notifier: Notifier;
  readonly automations: AutomationService;
  readonly transcripts: TranscriptStore;
  readonly sessions: SessionManager;
  private readonly server: HttpServer;

  constructor(private readonly hooks: HostHooks = { host: "web" }) {
    ensureDataDirs();
    this.bus.setMaxListeners(50);
    this.settings = new SettingsStore(this.bus);
    fs.mkdirSync(this.settings.get().workingDirectory, { recursive: true });
    this.copilot = new CopilotService(this.bus, this.settings);
    this.workiq = new WorkIqService(this.bus, this.settings);
    this.graph = new GraphService(this.bus, this.settings, (url) => this.openUrl(url));
    this.m365 = new M365Service(this.bus, this.settings, this.workiq, this.graph);
    this.memory = new MemoryStore(this.bus);
    this.skills = new SkillStore(this.bus, this.settings);
    this.notifier = new Notifier(this.bus, this.settings, this.m365);
    this.automations = new AutomationService(this.bus, this.settings, this.notifier);
    this.transcripts = new TranscriptStore();
    this.sessions = new SessionManager(this.bus, this.settings, this.copilot, this.m365, this.memory, this.skills, this.transcripts);
    this.sessions.toolContext = {
      settings: this.settings,
      m365: this.m365,
      memory: this.memory,
      automations: this.automations,
      skills: this.skills,
      notifier: this.notifier,
      sessions: this.sessions,
    };
    this.automations.runner = this.sessions;
    this.server = new HttpServer(this.token, this.bus, (method, params, client) => this.handle(method, params ?? {}, client), () => this.state());
    this.bus.on("settings.updated", (next: Settings, prev: Settings) => void this.onSettingsChanged(next, prev));
  }

  async start(opts: { port?: number } = {}): Promise<{ url: string; port: number; token: string }> {
    const port = await this.server.listen(opts.port ?? 0);
    void this.copilot.start().then(() => log("app", `GitHub Copilot: ${this.copilot.status.state}${this.copilot.status.login ? ` (${this.copilot.status.login})` : ""}`));
    void this.m365.start().then(() => {
      const s = this.m365.status();
      log("app", `Microsoft 365 (${s.provider === "graph" ? "direct Graph" : "Work IQ"}): ${s.state}${s.user?.mail ? ` (${s.user.mail})` : ""}`);
    });
    this.automations.start();
    void this.sessions.prune(this.settings.get().sessionRetentionDays).then((n) => n && log("app", `Pruned ${n} old conversations`));
    return { url: `http://127.0.0.1:${port}/?token=${this.token}`, port, token: this.token };
  }

  async stop(): Promise<void> {
    this.automations.stop();
    this.m365.stop();
    await this.copilot.stop();
    await this.server.close();
  }

  state(): Record<string, unknown> {
    const s = this.settings.get();
    return {
      app: { name: APP_NAME, version: APP_VERSION, host: this.hooks.host, dataDir: paths.data },
      settings: s,
      github: this.copilot.status,
      m365: this.m365.status(),
      models: this.copilot.modelSummaries(),
      personalities: PERSONALITIES.map(({ id, name, description }) => ({ id, name, description })),
      sessions: this.sessions.list(),
      pending: this.sessions.pendingFor(),
      automations: this.automations.list(),
      heartbeat: this.automations.heartbeatInfo(),
      memory: this.memory.list(),
      skills: this.skills.list(),
    };
  }

  private async onSettingsChanged(next: Settings, prev: Settings): Promise<void> {
    if (next.workingDirectory !== prev.workingDirectory) fs.mkdirSync(next.workingDirectory, { recursive: true });
    const m = (s: Settings) => JSON.stringify({ e: s.m365.enabled, p: s.m365.provider, a: s.m365.account, c: s.m365.clientId, t: s.m365.tenant, g: s.m365.scopeGroups });
    if (m(next) !== m(prev)) {
      await this.m365.start();
    } else if (next.m365.copilotLicense !== prev.m365.copilotLicense) {
      if (next.m365.provider === "workiq") await this.workiq.refreshStatus();
      this.m365.publish();
    }
    if (JSON.stringify(next.skillSources) !== JSON.stringify(prev.skillSources)) this.bus.publish("skills.changed", this.skills.list());
    if (JSON.stringify(next.heartbeat) !== JSON.stringify(prev.heartbeat) || JSON.stringify(next.workHours) !== JSON.stringify(prev.workHours)) {
      this.automations.reschedule();
    }
  }

  /** Opens a URL in the user's default browser (used for Microsoft 365 sign-in). */
  private async openUrl(url: string): Promise<void> {
    if (!/^https:\/\/login\.microsoftonline\.com\//i.test(url)) throw new Error("Refusing to open an unexpected sign-in URL.");
    if (process.env.OPENSCOUT_AUTH_NO_BROWSER === "1") {
      log("graph", `Open this URL to sign in: ${url}`);
      return;
    }
    if (this.hooks.openExternal) return this.hooks.openExternal(url);
    if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }

  private openWithOs(target: string): { revealed: boolean } {
    const isDir = fs.statSync(target).isDirectory();
    if (!isDir && RISKY_EXT.test(target)) {
      if (this.hooks.showItemInFolder) this.hooks.showItemInFolder(target);
      else if (process.platform === "win32") spawn("explorer.exe", [`/select,"${target}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
      return { revealed: true };
    }
    if (this.hooks.openPath) {
      void this.hooks.openPath(target);
      return { revealed: false };
    }
    const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [target], { detached: true, stdio: "ignore" }).unref();
    return { revealed: false };
  }

  /** WebSocket RPC surface used by the UI. */
  private async handle(method: string, p: Params, _client: ClientContext): Promise<unknown> {
    switch (method) {
      case "state":
        return this.state();

      // Conversations
      case "sessions.list":
        return this.sessions.list();
      case "session.open":
        return this.sessions.open(String(p.id));
      case "session.send":
        return {
          sessionId: await this.sessions.send({
            sessionId: p.sessionId || undefined,
            isNew: Boolean(p.isNew),
            prompt: String(p.prompt ?? ""),
            attachments: p.attachments,
            model: p.model || undefined,
          }),
        };
      case "session.abort":
        await this.sessions.abort(String(p.id));
        return true;
      case "session.delete":
        await this.sessions.delete(String(p.id));
        return true;
      case "session.rename":
        this.sessions.rename(String(p.id), String(p.title ?? ""));
        return true;
      case "session.setModel":
        await this.sessions.setModel(String(p.id), String(p.model));
        return true;
      case "session.search":
        return this.sessions.search(String(p.query ?? ""), 30);
      case "permission.respond":
        return this.sessions.resolvePermission(String(p.requestId), { decision: p.decision, feedback: p.feedback } as PermissionDecision);
      case "input.respond":
        return this.sessions.resolveInput(String(p.requestId), String(p.answer ?? ""), Boolean(p.wasFreeform));

      // Settings & accounts
      case "settings.update":
        return this.settings.update(p.patch ?? {});
      case "github.refresh":
        await this.copilot.refreshAuth();
        if (this.copilot.status.state === "signed-in") await this.copilot.refreshModels();
        return this.copilot.status;
      case "github.importCli":
        return this.copilot.signInFromCli();
      case "github.openLogin":
        return this.copilot.openCliLoginWindow();
      case "github.token":
        return this.copilot.signInWithToken(String(p.token ?? ""));
      case "models.refresh":
        await this.copilot.refreshModels();
        return this.copilot.modelSummaries();
      case "m365.refresh":
        return this.m365.refresh();
      case "m365.restart":
        await this.m365.start();
        return this.m365.status();
      case "m365.signIn":
        return this.m365.signIn();
      case "m365.signOut":
        return this.m365.signOut();
      case "workiq.acceptEula":
        await this.workiq.acceptEula();
        return this.m365.status();

      // Memory
      case "memory.list":
        return this.memory.list();
      case "memory.add":
        return this.memory.add(String(p.fact ?? ""), p.category, "user");
      case "memory.delete":
        return this.memory.remove(String(p.id));

      // Automations
      case "automations.list":
        return { automations: this.automations.list(), heartbeat: this.automations.heartbeatInfo() };
      case "automation.create":
        return this.automations.create(p.input ?? {});
      case "automation.update":
        return this.automations.update(String(p.id), p.input ?? {});
      case "automation.delete":
        return this.automations.remove(String(p.id));
      case "automation.run":
        return this.automations.runNow(String(p.id));
      case "automation.runs":
        return this.automations.runs(p.id ? String(p.id) : undefined, Number(p.limit) || 30);
      case "schedule.preview":
        try {
          const spec = parseSchedule(String(p.text ?? ""));
          return { ok: true, description: describeSchedule(spec), next: nextRun(spec, new Date(), this.settings.get().workHours)?.toISOString() };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }

      // Skills
      case "skills.list":
        return this.skills.list();
      case "skill.get":
        return this.skills.get(String(p.name));
      case "skill.save":
        return this.skills.save({ name: String(p.name ?? ""), description: String(p.description ?? ""), instructions: String(p.instructions ?? "") });
      case "skill.delete":
        return this.skills.remove(String(p.name));
      case "skill.toggle":
        this.skills.setEnabled(String(p.name), Boolean(p.enabled));
        return this.skills.list();

      // OS helpers
      case "os.openPath": {
        const target = path.resolve(String(p.path ?? ""));
        if (!p.path || !fs.existsSync(target)) throw new Error("That path doesn't exist.");
        return this.openWithOs(target);
      }
      case "os.openWorkingFolder":
        this.openWithOs(this.settings.get().workingDirectory);
        return true;
      case "os.openDataFolder":
        this.openWithOs(paths.data);
        return true;

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}
