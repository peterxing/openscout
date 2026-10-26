import type { AutomationService } from "../automations.js";
import type { M365Service } from "../m365.js";
import type { MemoryStore } from "../memory.js";
import type { Notifier } from "../notify.js";
import type { SettingsStore } from "../settings.js";
import type { SkillStore } from "../skills.js";

export interface SessionLookup {
  search(query: string, limit?: number): { sessionId: string; title: string; updatedAt: string; snippet: string }[];
  transcriptText(sessionId: string, lastN?: number): string;
}

export interface ToolContext {
  settings: SettingsStore;
  m365: M365Service;
  memory: MemoryStore;
  automations: AutomationService;
  skills: SkillStore;
  notifier: Notifier;
  sessions: SessionLookup;
}
