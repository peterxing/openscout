import { paths } from "./paths.js";
import { Bus, newId, readJson, writeJson } from "./util.js";

export type MemoryCategory = "preference" | "fact" | "decision" | "context";

export interface MemoryEntry {
  id: string;
  fact: string;
  category: MemoryCategory;
  source: "agent" | "user";
  createdAt: string;
}

const CATEGORIES: MemoryCategory[] = ["preference", "fact", "decision", "context"];
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "my", "me", "i", "what", "about", "with"]);

/** Long-term memory: small facts injected into every new session's system prompt. */
export class MemoryStore {
  private items: MemoryEntry[];

  constructor(private readonly bus: Bus) {
    this.items = readJson<MemoryEntry[]>(paths.memory, []);
  }

  list(): MemoryEntry[] {
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  add(fact: string, category: string | undefined, source: MemoryEntry["source"]): MemoryEntry {
    const clean = fact.trim().replace(/\s+/g, " ");
    if (!clean) throw new Error("Fact is empty.");
    const existing = this.items.find((m) => m.fact.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const entry: MemoryEntry = {
      id: newId("mem_"),
      fact: clean.slice(0, 1000),
      category: CATEGORIES.includes(category as MemoryCategory) ? (category as MemoryCategory) : "fact",
      source,
      createdAt: new Date().toISOString(),
    };
    this.items.push(entry);
    this.save();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  search(query: string, limit = 10): MemoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9@.\-]+/)
      .filter((t) => t && !STOP.has(t));
    if (!terms.length) return this.list().slice(0, limit);
    return this.items
      .map((m) => {
        const text = m.fact.toLowerCase();
        return { m, score: terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt))
      .slice(0, limit)
      .map((x) => x.m);
  }

  /** Most recent facts, capped so the system prompt stays small. */
  promptBlock(max = 60): string {
    const items = this.list().slice(0, max);
    if (!items.length) return "";
    return items.map((m) => `- [${m.category}] ${m.fact}`).join("\n");
  }

  private save(): void {
    writeJson(paths.memory, this.items);
    this.bus.publish("memory.changed", this.list());
  }
}
