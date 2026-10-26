import { defaultWorkspaceDir, paths } from "./paths.js";
import { Bus, deepMerge, readJson, writeJson } from "./util.js";

export type PermissionMode = "ask" | "auto-read" | "allow-all";
export type NotifyPolicy = "always" | "auto" | "never";
/** graph = OpenScout signs in to Microsoft 365 itself (no Microsoft 365 Copilot licence); workiq = via the Work IQ CLI. */
export type M365Provider = "graph" | "workiq";
export type Audience = "work" | "student";

export interface Settings {
  theme: "system" | "light" | "dark";
  defaultModel: string;
  reasoningEffort: "" | "low" | "medium" | "high" | "xhigh";
  personality: string;
  /** Tailors home-screen suggestions and guidance: work, or study (students). */
  audience: Audience;
  timezone: string;
  workingDirectory: string;
  permissions: {
    /** ask = prompt for everything; auto-read = auto-approve read-only actions; allow-all = never prompt. */
    mode: PermissionMode;
    /** Shell command prefixes that are always allowed (case-insensitive). */
    shellAllow: string[];
  };
  m365: {
    enabled: boolean;
    provider: M365Provider;
    /** Direct Graph: Entra app (client) ID to sign in with; empty = the quick-start public client. */
    clientId: string;
    /** Direct Graph: "organizations", "common", a tenant ID or a tenant domain. */
    tenant: string;
    /** Direct Graph: optional permission groups that need admin consent (see graph.ts). */
    scopeGroups: string[];
    /** Work IQ: enables ask/retrieve, which need a Microsoft 365 Copilot licence. */
    copilotLicense: boolean;
    /** Work IQ: account to use (--account). */
    account: string;
  };
  browser: { enabled: boolean; channel: "msedge" | "chrome" | "chromium"; headless: boolean };
  github: { mcpEnabled: boolean };
  /** desktop = native toast; email = send a summary to the user's own mailbox via Microsoft 365. */
  notifications: { desktop: boolean; email: boolean };
  heartbeat: {
    enabled: boolean;
    intervalMinutes: 15 | 30 | 60 | 120;
    schedule: "work-hours" | "always";
    prompt: string;
    emailNotify: NotifyPolicy;
  };
  workHours: { start: string; end: string; days: number[] };
  shortcut: { enabled: boolean; accelerator: string };
  closeToTray: boolean;
  sessionRetentionDays: number;
  skillSources: { scout: boolean; copilotCli: boolean };
  disabledSkills: string[];
}

export const DEFAULT_HEARTBEAT_PROMPT =
  "Do a quick check-in on my work. Look at unread email from the last few hours, my meetings in the next 3 hours, " +
  "and recent Teams chat messages that mention me or ask me something. Only surface items that genuinely need my " +
  "attention soon, as a short bulleted list with links. If nothing needs attention, reply with exactly [[quiet]].";

export function defaultSettings(): Settings {
  return {
    theme: "system",
    defaultModel: "auto",
    reasoningEffort: "",
    personality: "balanced",
    audience: "work",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDirectory: defaultWorkspaceDir(),
    permissions: {
      mode: "auto-read",
      shellAllow: ["Get-ChildItem", "Get-Content", "Get-Date", "Get-Location", "Test-Path", "dir", "type", "where"],
    },
    m365: {
      enabled: true,
      provider: "graph",
      clientId: process.env.OPENSCOUT_M365_CLIENT_ID ?? "",
      tenant: process.env.OPENSCOUT_M365_TENANT ?? "organizations",
      scopeGroups: [],
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
      prompt: DEFAULT_HEARTBEAT_PROMPT,
      emailNotify: "never",
    },
    workHours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    shortcut: { enabled: true, accelerator: "Control+Alt+O" },
    closeToTray: true,
    sessionRetentionDays: 365,
    skillSources: { scout: true, copilotCli: true },
    disabledSkills: [],
  };
}

const VALID_MODES: PermissionMode[] = ["ask", "auto-read", "allow-all"];
/** The Work IQ account ends up on a command line, so only allow plain UPN/email characters. */
export const ACCOUNT_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_RE = /^(organizations|common|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)$/i;

export class SettingsStore {
  private value: Settings;

  constructor(private readonly bus: Bus) {
    const saved = readJson<Partial<Settings> & { m365?: Partial<Settings["m365"]> }>(paths.settings, {});
    // Installs from before the direct Graph connection keep using Work IQ until the user switches.
    if (saved.m365 && saved.m365.provider === undefined) saved.m365 = { ...saved.m365, provider: "workiq" };
    this.value = deepMerge(defaultSettings(), saved);
    this.save();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: unknown): Settings {
    const next = deepMerge(this.value, patch);
    if (!VALID_MODES.includes(next.permissions.mode)) next.permissions.mode = "auto-read";
    if (![15, 30, 60, 120].includes(next.heartbeat.intervalMinutes)) next.heartbeat.intervalMinutes = 60;
    if (next.audience !== "student") next.audience = "work";
    next.sessionRetentionDays = Math.max(0, Math.floor(Number(next.sessionRetentionDays) || 0));
    next.m365.account = String(next.m365.account ?? "").trim();
    if (next.m365.account && !ACCOUNT_RE.test(next.m365.account)) throw new Error("The Microsoft 365 account must be an email address.");
    if (next.m365.provider !== "workiq") next.m365.provider = "graph";
    next.m365.clientId = String(next.m365.clientId ?? "").trim();
    if (next.m365.clientId && !GUID_RE.test(next.m365.clientId)) throw new Error("The application (client) ID must be a GUID from your Entra app registration.");
    next.m365.tenant = String(next.m365.tenant ?? "").trim() || "organizations";
    if (!TENANT_RE.test(next.m365.tenant)) throw new Error('The tenant must be "organizations", a tenant ID or a domain such as contoso.edu.');
    next.m365.scopeGroups = Array.isArray(next.m365.scopeGroups) ? [...new Set(next.m365.scopeGroups.map(String))] : [];
    if (!String(next.workingDirectory ?? "").trim()) next.workingDirectory = this.value.workingDirectory;
    const previous = this.value;
    this.value = next;
    this.save();
    this.bus.publish("settings.changed", this.value);
    this.bus.emit("settings.updated", this.value, previous);
    return this.value;
  }

  private save(): void {
    writeJson(paths.settings, this.value);
  }
}
