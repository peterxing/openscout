import { graphErrorText, SCOPE_GROUPS, type GraphResponse, type GraphService } from "./graph.js";
import { mcpText } from "./mcpClient.js";
import type { M365Provider, SettingsStore } from "./settings.js";
import { Bus, errorMessage } from "./util.js";
import { LICENSED_TOOLS, parseJsonSafe, TOOL_ALIASES, type WorkIqService } from "./workiq.js";

export interface M365User {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
}

export type M365State = "disabled" | "missing" | "starting" | "ready" | "signed-out" | "signing-in" | "eula" | "error";

export interface M365Status {
  provider: M365Provider;
  state: M365State;
  user?: M365User;
  message?: string;
  /** Work IQ only: ask/retrieve enabled (needs a Microsoft 365 Copilot licence). */
  copilotLicense: boolean;
  /** Direct Graph only. */
  signInApp?: string;
  clientId?: string;
  tenant?: string;
  scopeGroups: { id: string; label: string; enabled: boolean }[];
  tools: string[];
}

export interface OpResult {
  ok: boolean;
  json?: unknown;
  text: string;
}

export interface FileResult {
  ok: boolean;
  bytes?: Buffer;
  contentType?: string;
  fileName?: string;
  error?: string;
}

/** Tools both providers offer; Work IQ adds schema/path discovery (and ask/retrieve with a Copilot licence). */
export const CORE_TOOLS = ["m365_search", "m365_fetch", "m365_function", "m365_fetch_file", "m365_create", "m365_update", "m365_delete", "m365_action"];
const READ_ONLY_TOOLS = new Set([
  "m365_search",
  "m365_fetch",
  "m365_function",
  "m365_fetch_file",
  "m365_get_schema",
  "m365_search_paths",
  "m365_copilot_ask",
  "m365_copilot_retrieve",
  "m365_copilot_agents",
]);
/** Graph actions (POST) that only read data. */
const READ_ONLY_ACTIONS = /(\/search\/query|\/getSchedule|\/findMeetingTimes|\/getMemberGroups|\/checkMemberGroups|\/getMemberObjects)$/i;

export function isM365ReadOnly(tool: string, args?: Record<string, unknown>): boolean {
  if (tool === "m365_action") return READ_ONLY_ACTIONS.test(String(args?.actionUrl ?? "").split("?")[0].trim());
  return READ_ONLY_TOOLS.has(tool);
}

const WORKIQ_EXTRAS = new Set(["get_schema", "search_paths", ...LICENSED_TOOLS]);

/**
 * One Microsoft 365 surface for tools, notifications and prompts. Uses either OpenScout's own Graph sign-in
 * (default: works with any Microsoft 365 account, no Copilot licence) or the Work IQ CLI.
 */
export class M365Service {
  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    readonly workiq: WorkIqService,
    readonly graph: GraphService,
  ) {
    bus.on("graph.status", () => this.provider === "graph" && this.publish());
    bus.on("workiq.status", () => this.provider === "workiq" && this.publish());
  }

  get provider(): M365Provider {
    return this.settings.get().m365.provider;
  }

  /** Work IQ-only tools (schema/path discovery, licensed ask/retrieve) currently available to the model. */
  workIqExtras() {
    if (this.provider !== "workiq") return [];
    return this.workiq.modelTools().filter((t) => WORKIQ_EXTRAS.has(t.name));
  }

  status(): M365Status {
    const s = this.settings.get().m365;
    const scopeGroups = Object.entries(SCOPE_GROUPS).map(([id, g]) => ({ id, label: g.label, enabled: s.scopeGroups.includes(id) }));
    const base = { provider: s.provider, copilotLicense: s.copilotLicense, scopeGroups };
    if (!s.enabled) return { ...base, state: "disabled", tools: [] };
    if (s.provider === "graph") {
      const g = this.graph.status;
      return { ...base, state: g.state, user: g.user, message: g.message, signInApp: g.signInApp, clientId: g.clientId, tenant: g.tenant, tools: CORE_TOOLS };
    }
    const w = this.workiq.status;
    const extras = this.workIqExtras().map((t) => TOOL_ALIASES[t.name] ?? `m365_${t.name}`);
    return { ...base, state: w.state, user: w.user, message: w.message, tools: [...CORE_TOOLS, ...extras] };
  }

  get ready(): boolean {
    return this.status().state === "ready";
  }

  publish(): void {
    this.bus.publish("status.m365", this.status());
  }

  async start(): Promise<void> {
    const s = this.settings.get().m365;
    if (!s.enabled) {
      this.workiq.stop();
    } else if (s.provider === "graph") {
      this.workiq.stop();
      await this.graph.start();
    } else {
      await this.workiq.restart();
    }
    this.publish();
  }

  stop(): void {
    this.workiq.stop();
  }

  whenSettled(timeoutMs = 20_000): Promise<void> {
    return this.provider === "graph" ? this.graph.whenSettled(timeoutMs) : this.workiq.whenSettled(timeoutMs);
  }

  async refresh(): Promise<M365Status> {
    if (!this.settings.get().m365.enabled) return this.status();
    if (this.provider === "graph") await (this.graph.status.user ? this.graph.refreshStatus() : this.graph.start());
    else await (this.workiq.client ? this.workiq.refreshStatus() : this.workiq.restart());
    return this.status();
  }

  async signIn(): Promise<M365Status> {
    if (this.provider === "graph") await this.graph.signIn();
    else await this.workiq.signIn();
    return this.status();
  }

  async signOut(): Promise<M365Status> {
    if (this.provider === "graph") await this.graph.signOut();
    else await this.workiq.signOut();
    return this.status();
  }

  // ── Operations (Graph conventions; relative paths) ───────────────────────

  get(paths: string[]): Promise<OpResult> {
    const list = (Array.isArray(paths) ? paths : [paths]).map(String).slice(0, 10);
    if (this.provider === "workiq") return this.viaWorkIq("fetch", { entityUrls: list });
    return this.viaGraph(() => Promise.all(list.map((p) => this.graph.request("GET", p))));
  }

  fn(path: string, body?: unknown): Promise<OpResult> {
    if (this.provider === "workiq") return this.viaWorkIq("call_function", { functionUrl: path, ...(body !== undefined ? { jsonBody: body } : {}) });
    return this.viaGraph(() => this.graph.request("GET", path));
  }

  create(path: string, body: unknown): Promise<OpResult> {
    if (this.provider === "workiq") return this.viaWorkIq("create_entity", { parentUrl: path, jsonBody: body });
    return this.viaGraph(() => this.graph.request("POST", path, body));
  }

  update(path: string, body: unknown, headers?: Record<string, unknown>): Promise<OpResult> {
    if (this.provider === "workiq") return this.viaWorkIq("update_entity", { entityUrl: path, jsonBody: body, ...(headers ? { headers } : {}) });
    return this.viaGraph(() => this.graph.request("PATCH", path, body, headers));
  }

  remove(path: string, headers?: Record<string, unknown>): Promise<OpResult> {
    if (this.provider === "workiq") return this.viaWorkIq("delete_entity", { entityUrl: path, ...(headers ? { headers } : {}) });
    return this.viaGraph(() => this.graph.request("DELETE", path, undefined, headers));
  }

  action(path: string, body?: unknown): Promise<OpResult> {
    if (this.provider === "workiq") return this.viaWorkIq("do_action", { actionUrl: path, jsonBody: body ?? {} });
    const hasBody = body !== undefined && !(typeof body === "object" && body !== null && Object.keys(body).length === 0);
    return this.viaGraph(() => this.graph.request("POST", path, hasBody ? body : undefined));
  }

  async download(path: string, format?: string): Promise<FileResult> {
    if (this.provider === "workiq") {
      const r = await this.viaWorkIq("fetch_blob", { path, ...(format ? { format } : {}) }, 180_000);
      const sc = (r.json ?? {}) as Record<string, any>;
      if (!r.ok || !sc.base64Content) return { ok: false, error: sc.error ?? r.text.slice(0, 500) };
      return { ok: true, bytes: Buffer.from(sc.base64Content, "base64"), contentType: sc.contentType || sc.mimeType, fileName: sc.fileName || sc.name };
    }
    try {
      const d = await this.graph.download(path, format);
      if (!d.bytes) return { ok: false, error: d.error ?? `HTTP ${d.statusCode}` };
      let fileName = d.fileName;
      // Without a Content-Disposition header, look up the drive item's name.
      const item = /^(.*\/items\/[^/?]+)\/content\b/i.exec(path);
      if (!fileName && item) {
        const meta = await this.graph.request("GET", `${item[1]}?$select=name`).catch(() => null);
        fileName = (meta?.data as { name?: string } | undefined)?.name;
      }
      return { ok: true, bytes: d.bytes, contentType: d.contentType, fileName };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  private async viaWorkIq(tool: string, args: unknown, timeoutMs?: number): Promise<OpResult> {
    try {
      const res = await this.workiq.call(tool, args, timeoutMs);
      const text = mcpText(res) || "(empty result)";
      return { ok: !res.isError, json: res.structuredContent ?? parseJsonSafe(text), text };
    } catch (err) {
      return { ok: false, text: `Work IQ error: ${errorMessage(err)}` };
    }
  }

  private async viaGraph(run: () => Promise<GraphResponse | GraphResponse[]>): Promise<OpResult> {
    try {
      const r = await run();
      const list = Array.isArray(r) ? r : [r];
      const withHints = list.map((x) => (x.statusCode >= 400 ? { ...x, hint: graphErrorText(x) } : x));
      const json = Array.isArray(r) ? { results: withHints } : withHints[0];
      return { ok: list.every((x) => x.statusCode < 400), json, text: JSON.stringify(json) };
    } catch (err) {
      return { ok: false, text: `Microsoft 365 error: ${errorMessage(err)}` };
    }
  }
}
