import fs from "node:fs";
import path from "node:path";
import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { mcpText, type McpCallResult } from "../mcpClient.js";
import { errorMessage, truncate } from "../util.js";
import { LICENSED_TOOLS, parseJsonSafe, TOOL_ALIASES } from "../workiq.js";
import type { ToolContext } from "./context.js";

const MAX_RESULT = 40_000;
const ENTITY_TYPES = ["message", "event", "driveItem", "chatMessage", "person", "site", "listItem", "externalItem"] as const;
const TYPE_LABELS: Record<string, string> = {
  message: "Emails",
  event: "Calendar events",
  driveItem: "Files (OneDrive/SharePoint)",
  chatMessage: "Teams messages",
  person: "People",
  site: "SharePoint sites",
  listItem: "SharePoint list items",
  externalItem: "Connector items",
};

export function buildM365Tools(ctx: ToolContext): Tool<any>[] {
  const { workiq, settings } = ctx;
  if (!settings.get().m365.enabled || !workiq.client) return [];
  const tools: Tool<any>[] = [];
  for (const t of workiq.modelTools()) {
    const name = TOOL_ALIASES[t.name] ?? `m365_${t.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const licensed = LICENSED_TOOLS.has(t.name);
    const readOnly = t.name !== "do_action" && workiq.isReadOnly(t.name);
    tools.push(
      defineTool(name, {
        description: `${licensed ? "[Uses the Microsoft 365 Copilot licence] " : ""}${t.description ?? ""}`.trim(),
        parameters: cleanSchema(t.inputSchema, licensed),
        skipPermission: readOnly,
        metadata: { "openscout/m365Tool": t.name },
        handler: async (args: Record<string, unknown>) =>
          t.name === "fetch_blob" ? saveBlob(ctx, args) : callWorkIq(ctx, t.name, args),
      }),
    );
  }
  tools.push(searchTool(ctx));
  return tools;
}

function cleanSchema(schema: Record<string, unknown> | undefined, keepAgentParams: boolean): Record<string, unknown> {
  const s: any = structuredClone(schema ?? { type: "object", properties: {} });
  if (!keepAgentParams && s.properties) {
    delete s.properties.agentId;
    delete s.properties.includeDeveloperCard;
    if (Array.isArray(s.required)) s.required = s.required.filter((r: string) => r !== "agentId");
  }
  return s;
}

/** Drops @odata.context noise (keeps etags/nextLinks) and re-serialises compactly. */
function compactJson(text: string): string {
  const parsed = parseJsonSafe(text);
  if (parsed === undefined) return text;
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (k !== "@odata.context") out[k] = strip(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(parsed));
}

function toResult(res: McpCallResult): ToolResultObject {
  const text = compactJson(mcpText(res) || "(empty result)");
  const body = truncate(text, MAX_RESULT, "narrow the request with $select, $top or $filter");
  return res.isError ? { textResultForLlm: body, resultType: "failure", error: body.slice(0, 500) } : { textResultForLlm: body, resultType: "success" };
}

async function callWorkIq(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResultObject> {
  try {
    return toResult(await ctx.workiq.call(name, args, name === "ask" || name === "retrieve" ? 300_000 : 120_000));
  } catch (err) {
    return { textResultForLlm: `Work IQ error: ${errorMessage(err)}`, resultType: "failure", error: errorMessage(err) };
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

async function saveBlob(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResultObject> {
  let res: McpCallResult;
  try {
    res = await ctx.workiq.call("fetch_blob", args, 180_000);
  } catch (err) {
    return { textResultForLlm: `Work IQ error: ${errorMessage(err)}`, resultType: "failure", error: errorMessage(err) };
  }
  const sc: any = res.structuredContent ?? parseJsonSafe(mcpText(res)) ?? {};
  const inline = res.content?.find((c) => c.type === "image" || c.resource?.blob);
  const b64: string | undefined = sc.base64Content || inline?.data || inline?.resource?.blob;
  if (res.isError || !b64) return { textResultForLlm: truncate(mcpText(res) || "No file content returned.", 2000), resultType: "failure", error: sc.error ?? "fetch failed" };
  const mime: string = sc.contentType || sc.mimeType || inline?.mimeType || inline?.resource?.mimeType || "application/octet-stream";
  const rawName = String(sc.fileName || sc.name || path.basename(String(args.path ?? "file").split("?")[0]) || "file").replace(/\$value/g, "file");
  let fileName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 120) || "file";
  if (!path.extname(fileName) && EXT_BY_MIME[mime]) fileName += EXT_BY_MIME[mime];
  const dir = path.join(ctx.settings.get().workingDirectory, "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.parse(fileName).name} (${i})${path.extname(fileName)}`);
  const bytes = Buffer.from(b64, "base64");
  fs.writeFileSync(target, bytes);
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(mime) && bytes.length < 3_500_000;
  return {
    textResultForLlm: `Saved ${bytes.length.toLocaleString()} bytes (${mime}) to ${target}`,
    resultType: "success",
    ...(isImage ? { binaryResultsForLlm: [{ type: "image" as const, data: b64, mimeType: mime }] } : {}),
  };
}

function findHitsContainer(v: any): any {
  if (!v || typeof v !== "object") return undefined;
  if (Array.isArray(v.hitsContainers)) return v.hitsContainers[0];
  for (const child of Array.isArray(v) ? v : Object.values(v)) {
    const found = findHitsContainer(child);
    if (found) return found;
  }
  return undefined;
}

function cleanSummary(s: unknown): string {
  return String(s ?? "")
    .replace(/<ddd\/>/g, "…")
    .replace(/<\/?c\d+>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function searchTool(ctx: ToolContext): Tool<any> {
  const fmtDate = (v: unknown): string => {
    if (!v) return "";
    const iso = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (Number.isNaN(d.getTime())) return iso;
    try {
      return new Intl.DateTimeFormat("en-AU", { timeZone: ctx.settings.get().timezone, dateStyle: "medium", timeStyle: "short" }).format(d);
    } catch {
      return d.toISOString();
    }
  };
  const link = (u: unknown) => (u ? ` · [open](${u})` : "");

  const fmtHit = (type: string, hit: any, n: number): string => {
    const r = hit.resource ?? {};
    const snippet = cleanSummary(hit.summary);
    const tail = snippet ? `\n   ${snippet}` : "";
    switch (type) {
      case "message":
        return `${n}. **${r.subject || "(no subject)"}** — ${r.from?.emailAddress?.name ?? ""} <${r.from?.emailAddress?.address ?? ""}> · ${fmtDate(r.receivedDateTime ?? r.sentDateTime)}${link(r.webLink)}\n   id: ${r.id ?? hit.hitId}${tail}`;
      case "event":
        return `${n}. **${r.subject || "(no subject)"}** — ${fmtDate(r.start?.dateTime)} → ${fmtDate(r.end?.dateTime)}${r.isAllDay ? " (all day)" : ""}${link(r.webLink)}\n   id: ${r.id ?? hit.hitId}${tail}`;
      case "driveItem":
        return `${n}. **${r.name ?? "(file)"}** — modified ${fmtDate(r.lastModifiedDateTime)}${r.lastModifiedBy?.user?.displayName ? ` by ${r.lastModifiedBy.user.displayName}` : ""}${link(r.webUrl)}\n   driveId: ${r.parentReference?.driveId ?? "?"} · itemId: ${r.id ?? hit.hitId}${tail}`;
      case "chatMessage": {
        const who = r.from?.emailAddress?.name ?? r.from?.user?.displayName ?? "";
        const where = r.chatId ? `chatId: ${r.chatId}` : r.channelIdentity ? `teamId: ${r.channelIdentity.teamId} · channelId: ${r.channelIdentity.channelId}` : "";
        return `${n}. ${who ? `**${who}**` : "Message"} · ${fmtDate(r.createdDateTime ?? r.lastModifiedDateTime)}${link(r.webLink ?? r.webUrl)}\n   id: ${r.id ?? hit.hitId}${where ? ` · ${where}` : ""}${tail}`;
      }
      case "person":
        return `${n}. **${r.displayName ?? ""}** — ${[r.jobTitle, r.department, r.officeLocation].filter(Boolean).join(", ")} · ${r.scoredEmailAddresses?.[0]?.address ?? r.emailAddresses?.[0]?.address ?? r.userPrincipalName ?? ""}`;
      default:
        return `${n}. **${r.displayName ?? r.name ?? r.title ?? hit.hitId}**${link(r.webUrl)}${tail}`;
    }
  };

  return defineTool("m365_search", {
    description:
      "Search the user's Microsoft 365 content with Microsoft Search through Work IQ (no Microsoft 365 Copilot licence needed). " +
      "Covers emails (message), calendar events (event), OneDrive/SharePoint files (driveItem), Teams chat and channel messages (chatMessage), " +
      "people (person), SharePoint sites (site) and list items (listItem). The query accepts keywords and KQL, e.g. 'budget from:alex', " +
      "'subject:\"QBR\"', 'filetype:pptx roadmap', 'received>=2026-01-01'. Returns ranked hits with titles, people, dates, snippets, IDs and links; " +
      "use m365_fetch with the IDs to read full items.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or KQL." },
        entityTypes: {
          type: "array",
          items: { type: "string", enum: [...ENTITY_TYPES] },
          description: "Kinds of content to search. Defaults to message, event, driveItem and chatMessage.",
        },
        size: { type: "integer", minimum: 1, maximum: 25, description: "Hits per content type (default 8)." },
        from: { type: "integer", minimum: 0, description: "Offset for paging (default 0)." },
      },
      required: ["query"],
    },
    skipPermission: true,
    handler: async (args: { query: string; entityTypes?: string[]; size?: number; from?: number }) => {
      const types = (args.entityTypes?.length ? args.entityTypes : ["message", "event", "driveItem", "chatMessage"]).filter((t) =>
        (ENTITY_TYPES as readonly string[]).includes(t),
      );
      const size = Math.min(25, Math.max(1, Number(args.size) || 8));
      const from = Math.max(0, Number(args.from) || 0);
      const sections = await Promise.all(
        types.map(async (type) => {
          const label = `### ${TYPE_LABELS[type] ?? type} (${type})`;
          try {
            const res = await ctx.workiq.call("do_action", {
              actionUrl: "/search/query",
              jsonBody: { requests: [{ entityTypes: [type], query: { queryString: args.query }, from, size }] },
            });
            const container = findHitsContainer(res.structuredContent ?? parseJsonSafe(mcpText(res)));
            if (res.isError || !container) return `${label}\nNo results or error: ${truncate(mcpText(res), 300)}`;
            const hits: any[] = container.hits ?? [];
            if (!hits.length) return `${label}\nNo matches.`;
            const header = `${label} — ${Number(container.total ?? hits.length).toLocaleString()} matches, showing ${from + 1}–${from + hits.length}${container.moreResultsAvailable ? " (more available)" : ""}`;
            return `${header}\n${hits.map((h, i) => fmtHit(type, h, from + i + 1)).join("\n")}`;
          } catch (err) {
            return `${label}\nError: ${errorMessage(err)}`;
          }
        }),
      );
      return sections.join("\n\n");
    },
  });
}
