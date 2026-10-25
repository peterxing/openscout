import { defaultWorkspaceDir, paths } from "./paths.js";
import { Bus, deepMerge, readJson, writeJson } from "./util.js";

export type PermissionMode = "ask" | "auto-read" | "allow-all";
export type NotifyPolicy = "always" | "auto" | "never";

export interface Settings {
  theme: "system" | "light" | "dark";
  defaultModel: string;
  reasoningEffort: "" | "low" | "medium" | "high" | "xhigh";
  personality: string;
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
    /** Enables Work IQ's ask/retrieve tools, which need a Microsoft 365 Copilot licence. */
    copilotLicense: boolean;
    account: string;
  };
  browser: { enabled: boolean; channel: "msedge" | "chrome" | "chromium"; headless: boolean };
  github: { mcpEnabled: boolean };
  /** desktop = native toast; email = send a summary to the user's own mailbox via Work IQ. */
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
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDirectory: defaultWorkspaceDir(),
    permissions: {
      mode: "auto-read",
      shellAllow: ["Get-ChildItem", "Get-Content", "Get-Date", "Get-Location", "Test-Path", "dir", "type", "where"],
    },
    m365: { enabled: true, copilotLicense: false, account: "" },
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

export class SettingsStore {
  private value: Settings;

  constructor(private readonly bus: Bus) {
    this.value = deepMerge(defaultSettings(), readJson<Partial<Settings>>(paths.settings, {}));
    this.save();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: unknown): Settings {
    const next = deepMerge(this.value, patch);
    if (!VALID_MODES.includes(next.permissions.mode)) next.permissions.mode = "auto-read";
    if (![15, 30, 60, 120].includes(next.heartbeat.intervalMinutes)) next.heartbeat.intervalMinutes = 60;
    next.sessionRetentionDays = Math.max(0, Math.floor(Number(next.sessionRetentionDays) || 0));
    next.m365.account = String(next.m365.account ?? "").trim();
    if (next.m365.account && !ACCOUNT_RE.test(next.m365.account)) throw new Error("The Microsoft 365 account must be an email address.");
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
