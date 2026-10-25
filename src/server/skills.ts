import fs from "node:fs";
import path from "node:path";
import { paths, userSkillDirs } from "./paths.js";
import type { SettingsStore } from "./settings.js";
import type { Bus } from "./util.js";

export interface SkillInfo {
  name: string;
  description: string;
  source: "openscout" | "scout" | "copilot-cli";
  dir: string;
  enabled: boolean;
  editable: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v.replace(/\\"/g, '"');
  }
  return { meta, body: m[2] };
}

/**
 * Skills use the Agent Skills layout (<root>/<name>/SKILL.md with name/description frontmatter),
 * so the Copilot runtime can discover and load them through its built-in `skill` tool.
 */
export class SkillStore {
  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
  ) {
    fs.mkdirSync(paths.skills, { recursive: true });
  }

  /** Skill roots handed to the runtime, in precedence order. */
  roots(): { dir: string; source: SkillInfo["source"] }[] {
    const s = this.settings.get().skillSources;
    const ext = userSkillDirs();
    const roots: { dir: string; source: SkillInfo["source"] }[] = [{ dir: paths.skills, source: "openscout" }];
    if (s.scout && fs.existsSync(ext.scout)) roots.push({ dir: ext.scout, source: "scout" });
    if (s.copilotCli && fs.existsSync(ext.copilotCli)) roots.push({ dir: ext.copilotCli, source: "copilot-cli" });
    return roots;
  }

  list(): SkillInfo[] {
    const disabled = new Set(this.settings.get().disabledSkills);
    const seen = new Set<string>();
    const out: SkillInfo[] = [];
    for (const root of this.roots()) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(root.dir, e.name, "SKILL.md");
        if (!fs.existsSync(file)) continue;
        const { meta } = parseFrontmatter(fs.readFileSync(file, "utf8"));
        const name = meta.name || e.name;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          description: meta.description || "",
          source: root.source,
          dir: path.join(root.dir, e.name),
          enabled: !disabled.has(name),
          editable: root.source === "openscout",
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): (SkillInfo & { content: string }) | null {
    const info = this.list().find((s) => s.name === name);
    if (!info) return null;
    return { ...info, content: fs.readFileSync(path.join(info.dir, "SKILL.md"), "utf8") };
  }

  save(input: { name: string; description: string; instructions: string }): SkillInfo {
    const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!NAME_RE.test(name)) throw new Error("Skill names use lowercase letters, numbers and hyphens (max 63 chars).");
    const description = input.description.trim().replace(/\s+/g, " ");
    if (!description) throw new Error("A description is required so the agent knows when to use the skill.");
    const existing = this.list().find((s) => s.name === name);
    if (existing && !existing.editable) throw new Error(`"${name}" comes from ${existing.source} and can't be edited here.`);
    const dir = path.join(paths.skills, name);
    fs.mkdirSync(dir, { recursive: true });
    const body = (input.instructions || description).trim();
    const fm = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), fm);
    this.bus.publish("skills.changed", this.list());
    return this.list().find((s) => s.name === name)!;
  }

  remove(name: string): boolean {
    const s = this.list().find((x) => x.name === name);
    if (!s || !s.editable) return false;
    fs.rmSync(s.dir, { recursive: true, force: true });
    this.bus.publish("skills.changed", this.list());
    return true;
  }

  setEnabled(name: string, enabled: boolean): void {
    const disabled = new Set(this.settings.get().disabledSkills);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    this.settings.update({ disabledSkills: [...disabled] });
    this.bus.publish("skills.changed", this.list());
  }
}
