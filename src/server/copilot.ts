import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import { paths } from "./paths.js";
import type { SettingsStore } from "./settings.js";
import { Bus, errorMessage, log, parseJsonc, readJson, writeJson } from "./util.js";

export interface GitHubStatus {
  state: "starting" | "signed-in" | "signed-out" | "error";
  login?: string;
  host?: string;
  authType?: string;
  message?: string;
  /** True when a GitHub Copilot CLI login exists that can be imported. */
  cliLoginAvailable: boolean;
}

interface CliConfig {
  lastLoggedInUser?: { host: string; login: string };
  loggedInUsers?: { host: string; login: string }[];
}

const CLI_CONFIG = path.join(os.homedir(), ".copilot", "config.json");

/**
 * Owns the GitHub Copilot runtime (via @github/copilot-sdk). The runtime gets its own
 * COPILOT_HOME (~/.openscout/copilot) so OpenScout's sessions, MCP config and plugins stay
 * separate from the user's Copilot CLI, while still reusing their GitHub sign-in.
 */
export class CopilotService {
  client: CopilotClient | null = null;
  status: GitHubStatus = { state: "starting", cliLoginAvailable: false };
  models: ModelInfo[] = [];
  private starting: Promise<void> | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
  ) {}

  async start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    try {
      await this.startClient();
      await this.refreshAuth();
      if (this.status.state !== "signed-in" && this.importCliLogin()) {
        log("copilot", "Imported GitHub Copilot CLI sign-in; restarting runtime");
        await this.restart();
      }
      if (this.status.state === "signed-in") await this.refreshModels();
    } catch (err) {
      this.setStatus({ state: "error", message: errorMessage(err) });
    }
  }

  private async startClient(): Promise<void> {
    fs.mkdirSync(paths.copilotHome, { recursive: true });
    const workingDirectory = this.settings.get().workingDirectory;
    fs.mkdirSync(workingDirectory, { recursive: true });
    this.client = new CopilotClient({
      baseDirectory: paths.copilotHome,
      workingDirectory,
      logLevel: "error",
    });
    await this.client.start();
  }

  async restart(): Promise<void> {
    const old = this.client;
    this.client = null;
    if (old) await old.stop().catch(() => []);
    // Live session handles belong to the old runtime process.
    this.bus.emit("copilot.restarted");
    await this.startClient();
    await this.refreshAuth();
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.stop().catch(() => []);
  }

  requireClient(): CopilotClient {
    if (!this.client) throw new Error("The GitHub Copilot runtime is not running yet.");
    return this.client;
  }

  async refreshAuth(): Promise<GitHubStatus> {
    const cliLoginAvailable = this.cliLogin() !== null;
    try {
      const s = await this.requireClient().getAuthStatus();
      this.setStatus(
        s.isAuthenticated
          ? { state: "signed-in", login: s.login, host: s.host, authType: s.authType, cliLoginAvailable }
          : { state: "signed-out", message: s.statusMessage, cliLoginAvailable },
      );
    } catch (err) {
      this.setStatus({ state: "error", message: errorMessage(err), cliLoginAvailable });
    }
    return this.status;
  }

  async refreshModels(): Promise<ModelInfo[]> {
    try {
      this.models = await this.requireClient().listModels();
      this.bus.publish("models", this.modelSummaries());
    } catch (err) {
      log("copilot", "listModels failed:", errorMessage(err));
    }
    return this.models;
  }

  modelSummaries(): { id: string; name: string; multiplier?: number; vision: boolean; reasoning: boolean; contextTokens: number }[] {
    return this.models
      .filter((m) => m.policy?.state !== "disabled")
      .map((m) => ({
        id: m.id,
        name: m.name,
        multiplier: m.billing?.multiplier,
        vision: Boolean(m.capabilities?.supports?.vision),
        reasoning: Boolean(m.capabilities?.supports?.reasoningEffort),
        contextTokens: m.capabilities?.limits?.max_context_window_tokens ?? 0,
      }));
  }

  /** Reads the host/login pointer of the user's Copilot CLI sign-in (the token itself stays in the OS keychain). */
  private cliLogin(): CliConfig | null {
    try {
      const cfg = parseJsonc<CliConfig>(fs.readFileSync(CLI_CONFIG, "utf8"));
      return cfg.loggedInUsers?.length ? cfg : null;
    } catch {
      return null;
    }
  }

  importCliLogin(): boolean {
    const cli = this.cliLogin();
    if (!cli?.loggedInUsers?.length) return false;
    const target = path.join(paths.copilotHome, "config.json");
    const current = readJson<Record<string, unknown>>(target, {});
    writeJson(target, {
      ...current,
      lastLoggedInUser: cli.lastLoggedInUser ?? cli.loggedInUsers[0],
      loggedInUsers: cli.loggedInUsers,
    });
    return true;
  }

  async signInFromCli(): Promise<GitHubStatus> {
    if (!this.importCliLogin()) {
      this.setStatus({
        state: "signed-out",
        message: "No GitHub Copilot CLI sign-in found. Run `copilot login` first.",
        cliLoginAvailable: false,
      });
      return this.status;
    }
    await this.restart();
    if (this.status.state === "signed-in") await this.refreshModels();
    return this.status;
  }

  /** Stores a GitHub token (fine-grained PAT with the "Copilot Requests" permission, or an OAuth token) in the keychain. */
  async signInWithToken(token: string): Promise<GitHubStatus> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Token is empty.");
    await this.requireClient().rpc.account.login({ host: "https://github.com", token: trimmed });
    await this.restart();
    if (this.status.state === "signed-in") await this.refreshModels();
    return this.status;
  }

  /** Opens a console window running the Copilot CLI device-flow login. */
  openCliLoginWindow(): { launched: boolean; instructions: string } {
    const instructions =
      "Complete the GitHub sign-in in the console window, then click “I've signed in”. " +
      "If nothing opens, run `npx -y @github/copilot@latest login` in a terminal.";
    if (process.platform !== "win32") return { launched: false, instructions };
    const child = spawn("cmd.exe", ["/k", "copilot login || npx -y @github/copilot@latest login"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { launched: true, instructions };
  }

  private setStatus(s: Omit<GitHubStatus, "cliLoginAvailable"> & { cliLoginAvailable?: boolean }): void {
    this.status = { cliLoginAvailable: this.cliLogin() !== null, ...s };
    this.bus.publish("status.github", this.status);
  }
}
