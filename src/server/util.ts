import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    // Rename can fail on Windows if another process holds the file; fall back to a direct write.
    fs.writeFileSync(file, body);
    fs.rmSync(tmp, { force: true });
  }
}

export function appendJsonl(file: string, entry: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip torn lines (e.g. after a crash mid-write).
    }
  }
  return out;
}

/** Copilot CLI's config.json allows full-line // comments. */
export function parseJsonc<T>(text: string): T {
  return JSON.parse(
    text
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  ) as T;
}

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge where arrays and primitives in `patch` replace values in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function truncate(text: string, max: number, note = ""): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters${note ? `; ${note}` : ""}]`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BroadcastMessage {
  event: string;
  payload: unknown;
}

/** In-process event bus; the WebSocket hub and Electron shell subscribe to "broadcast". */
export class Bus extends EventEmitter {
  publish(event: string, payload: unknown): void {
    this.emit("broadcast", { event, payload } satisfies BroadcastMessage);
  }
}

export function log(scope: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [${scope}]`, ...args);
}
