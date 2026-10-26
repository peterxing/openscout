import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { McpStdioClient, mcpText, type McpCallResult, type McpTool } from "./mcpClient.js";
import { NODE_MODULES } from "./paths.js";
import { ACCOUNT_RE, type SettingsStore } from "./settings.js";
import { Bus, errorMessage, log } from "./util.js";

export interface WorkIqUser {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
}

export interface WorkIqStatus {
  state: "disabled" | "missing" | "starting" | "ready" | "signed-out" | "eula" | "error";
  user?: WorkIqUser;
  message?: string;
  serverVersion?: string;
  tools: string[];
  copilotLicense: boolean;
}

/** Work IQ tools that call the Microsoft 365 Copilot Chat/Retrieval APIs (need an M365 Copilot licence). */
export const LICENSED_TOOLS = new Set(["ask", "retrieve", "list_agents"]);
/** Tools OpenScout never hands to the model (handled by the app UI instead). */
const HIDDEN_TOOLS = new Set(["accept_eula", "get_debug_link"]);

export const TOOL_ALIASES: Record<string, string> = {
  fetch: "m365_fetch",
  fetch_blob: "m365_fetch_file",
  create_entity: "m365_create",
  update_entity: "m365_update",
  delete_entity: "m365_delete",
  do_action: "m365_action",
  call_function: "m365_function",
  get_schema: "m365_get_schema",
  search_paths: "m365_search_paths",
  ask: "m365_copilot_ask",
  retrieve: "m365_copilot_retrieve",
  list_agents: "m365_copilot_agents",
};

function resolveExe(): string | null {
  const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const exe = path.join(NODE_MODULES, "@microsoft", "workiq", "bin", `${plat}-${arch}`, process.platform === "win32" ? "workiq.exe" : "workiq");
  return fs.existsSync(exe) ? exe : null;
}

/**
 * Talks to the user's Work IQ (Microsoft 365) access through the Work IQ CLI's MCP server.
 * Entity tools (fetch/create/update/delete/do_action/call_function) go straight to Microsoft Graph
 * with the user's delegated token, so they work without a Microsoft 365 Copilot licence.
 */
export class WorkIqService {
  readonly exe = resolveExe();
  client: McpStdioClient | null = null;
  status: WorkIqStatus;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
  ) {
    this.status = { state: "starting", tools: [], copilotLicense: settings.get().m365.copilotLicense };
  }

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Resolves once startup finished (or after `timeoutMs`), so session creation never blocks for long. */
  async whenSettled(timeoutMs = 20_000): Promise<void> {
    const pending = this.starting;
    if (!pending) return;
    await Promise.race([pending.catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async doStart(): Promise<void> {
    const s = this.settings.get();
    if (!s.m365.enabled || s.m365.provider !== "workiq") {
      this.client?.stop();
      this.client = null;
      this.setStatus({ state: "disabled", tools: [] });
      return;
    }
    if (!this.exe) {
      this.setStatus({ state: "missing", message: "Work IQ CLI not found. Run `npm install` to fetch @microsoft/workiq.", tools: [] });
      return;
    }
    this.setStatus({ state: "starting", tools: [] });
    this.client?.stop();
    const args = ["mcp", ...(s.m365.account && ACCOUNT_RE.test(s.m365.account) ? ["--account", s.m365.account] : [])];
    this.client = new McpStdioClient(this.exe, args);
    try {
      await this.client.start();
      await this.refreshStatus();
    } catch (err) {
      this.setStatus({ state: "error", message: errorMessage(err), tools: [] });
    }
  }

  async restart(): Promise<void> {
    this.client?.stop();
    this.client = null;
    await this.start();
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
  }

  /** Probes identity with a cheap Graph read; classifies failures into sign-in / EULA / other. */
  async refreshStatus(): Promise<WorkIqStatus> {
    if (!this.client) return this.status;
    try {
      const res = await this.call("fetch", { entityUrls: ["/me?$select=displayName,mail,userPrincipalName,jobTitle"] }, 90_000);
      const parsed = parseJsonSafe(mcpText(res)) as any;
      const data = parsed?.results?.[0]?.data ?? (res.structuredContent as any)?.results?.[0]?.data;
      if (res.isError || !data) {
        const msg = mcpText(res) || "Work IQ returned no profile.";
        this.setStatus({ state: classify(msg), message: msg.slice(0, 400), tools: this.toolNames() });
      } else {
        this.setStatus({
          state: "ready",
          user: { displayName: data.displayName, mail: data.mail, userPrincipalName: data.userPrincipalName, jobTitle: data.jobTitle },
          serverVersion: this.client.serverInfo.version,
          tools: this.toolNames(),
        });
      }
    } catch (err) {
      const msg = errorMessage(err);
      this.setStatus({ state: classify(msg), message: msg.slice(0, 400), tools: this.toolNames() });
    }
    return this.status;
  }

  async call(name: string, args: unknown, timeoutMs = 120_000): Promise<McpCallResult> {
    if (!this.client) throw new Error("Microsoft 365 (Work IQ) is not enabled or not running.");
    return this.client.callTool(name, args, timeoutMs);
  }

  /** MCP tools the model may use, honouring the M365 Copilot licence setting. */
  modelTools(): McpTool[] {
    const licensed = this.settings.get().m365.copilotLicense;
    return (this.client?.tools ?? []).filter((t) => !HIDDEN_TOOLS.has(t.name) && (licensed || !LICENSED_TOOLS.has(t.name)));
  }

  async acceptEula(): Promise<WorkIqStatus> {
    await this.runCli(["accept-eula"], { input: "y\n", timeoutMs: 60_000 });
    await this.restart();
    return this.status;
  }

  /** Interactive sign-in; opens a visible console so any device-code or broker prompt is shown. */
  async signIn(): Promise<WorkIqStatus> {
    await this.runCli(["auth", "login"], { visible: true, timeoutMs: 600_000 });
    await this.restart();
    return this.status;
  }

  async signOut(): Promise<WorkIqStatus> {
    await this.runCli(["auth", "logout"], { timeoutMs: 60_000 });
    await this.restart();
    return this.status;
  }

  private runCli(args: string[], opts: { visible?: boolean; input?: string; timeoutMs: number }): Promise<{ code: number | null; out: string }> {
    const exe = this.exe;
    if (!exe) return Promise.reject(new Error("Work IQ CLI not found."));
    const account = this.settings.get().m365.account;
    const fullArgs = account && ACCOUNT_RE.test(account) ? [...args, "--account", account] : args;
    return new Promise((resolve) => {
      const child =
        opts.visible && process.platform === "win32"
          ? spawn("cmd.exe", ["/c", exe, ...fullArgs], { detached: true, stdio: "ignore", windowsHide: false })
          : spawn(exe, fullArgs, { windowsHide: true });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      if (opts.input && child.stdin) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, out: out + "\n(timed out)" });
      }, opts.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        log("workiq", `workiq ${args.join(" ")} exited ${code}`);
        resolve({ code, out });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, out: err.message });
      });
    });
  }

  private toolNames(): string[] {
    return this.modelTools().map((t) => TOOL_ALIASES[t.name] ?? `m365_${t.name}`);
  }

  private setStatus(s: Omit<WorkIqStatus, "copilotLicense">): void {
    this.status = { ...s, copilotLicense: this.settings.get().m365.copilotLicense };
    // M365Service re-publishes this to the UI when Work IQ is the active provider.
    this.bus.emit("workiq.status", this.status);
  }
}

function classify(message: string): WorkIqStatus["state"] {
  if (/eula/i.test(message)) return "eula";
  if (/(sign[ -]?in|log[ -]?in|interactive|consent|AADSTS|unauthori[sz]ed|no account|token)/i.test(message)) return "signed-out";
  return "error";
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    if (i < 0) return undefined;
    try {
      return JSON.parse(text.slice(i));
    } catch {
      return undefined;
    }
  }
}
