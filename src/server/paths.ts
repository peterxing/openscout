import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_NAME = "OpenScout";
export const APP_VERSION = "0.1.0";

export const DATA_DIR = process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout");

export const paths = {
  data: DATA_DIR,
  settings: path.join(DATA_DIR, "settings.json"),
  memory: path.join(DATA_DIR, "memory.json"),
  automations: path.join(DATA_DIR, "automations.json"),
  automationRuns: path.join(DATA_DIR, "automation-runs.jsonl"),
  sessions: path.join(DATA_DIR, "sessions.json"),
  transcripts: path.join(DATA_DIR, "transcripts"),
  skills: path.join(DATA_DIR, "skills"),
  copilotHome: path.join(DATA_DIR, "copilot"),
  browserProfile: path.join(DATA_DIR, "browser-profile"),
  browserOutput: path.join(DATA_DIR, "browser-output"),
  logs: path.join(DATA_DIR, "logs"),
  windowState: path.join(DATA_DIR, "window-state.json"),
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled files live in dist/<area>/, so the project root is two levels up.
export const ROOT_DIR = path.resolve(here, "..", "..");
export const WEB_DIR = path.join(ROOT_DIR, "web");
export const ASSETS_DIR = path.join(ROOT_DIR, "assets");
export const NODE_MODULES = path.join(ROOT_DIR, "node_modules");

export function ensureDataDirs(): void {
  for (const dir of [
    paths.data,
    paths.transcripts,
    paths.skills,
    paths.copilotHome,
    paths.browserProfile,
    paths.browserOutput,
    paths.logs,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Default folder the agent works in (mirrors Scout's "Documents\Microsoft Scout"). */
export function defaultWorkspaceDir(): string {
  const candidates = [
    process.env.OneDriveCommercial && path.join(process.env.OneDriveCommercial, "Documents"),
    process.env.OneDrive && path.join(process.env.OneDrive, "Documents"),
    path.join(os.homedir(), "Documents"),
  ].filter((p): p is string => Boolean(p));
  const docs = candidates.find((c) => fs.existsSync(c)) ?? os.homedir();
  return path.join(docs, APP_NAME);
}

export function userSkillDirs(): { scout: string; copilotCli: string } {
  return {
    scout: path.join(os.homedir(), ".scout", "m-skills"),
    copilotCli: path.join(os.homedir(), ".copilot", "skills"),
  };
}
