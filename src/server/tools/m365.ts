import fs from "node:fs";
import path from "node:path";
import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import type { OpResult } from "../m365.js";
import { errorMessage, truncate } from "../util.js";
import { parseJsonSafe, TOOL_ALIASES } from "../workiq.js";
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

const str = (description: string) => ({ type: "string", description });
const obj = (description: string) => ({ type: "object", description, additionalProperties: true });
const headersSchema = { type: "object", description: "Optional request headers (only If-Match, Prefer and ConsistencyLevel are sent).", additionalProperties: { type: "string" } };

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

function toResult(r: OpResult): ToolResultObject {
  const body = truncate(compactJson(r.text), MAX_RESULT, "narrow the request with $select, $top or $filter");
  return r.ok ? { textResultForLlm: body, resultType: "success" } : { textResultForLlm: body, resultType: "failure", error: body.slice(0, 500) };
}

const guard = async (run: () => Promise<OpResult>): Promise<ToolResultObject> => {
  try {
    return toResult(await run());
  } catch (err) {
    return { textResultForLlm: `Microsoft 365 error: ${errorMessage(err)}`, resultType: "failure", error: errorMessage(err) };
  }
};

export function buildM365Tools(ctx: ToolContext): Tool<any>[] {
  const { m365, settings } = ctx;
  if (!settings.get().m365.enabled) return [];
  const tools: Tool<any>[] = [
    searchTool(ctx),
    defineTool("m365_fetch", {
      description:
        "Read the user's Microsoft 365 data with one or more Microsoft Graph GET requests. Pass relative Graph paths, e.g. " +
        "/me/messages?$top=10&$select=subject,from,receivedDateTime or /me/calendarView?startDateTime=…&endDateTime=…. " +
        "Always include $select and $top. To act on an item the user names, first find its ID here (with $filter or $search).",
      parameters: { type: "object", properties: { entityUrls: { type: "array", items: { type: "string" }, description: "Up to 10 relative Graph paths." } }, required: ["entityUrls"] },
      skipPermission: true,
      handler: async (a: { entityUrls: string[] }) => guard(() => m365.get(a.entityUrls)),
    }),
    defineTool("m365_function", {
      description:
        "Call a read-only Microsoft Graph function, e.g. /me/drive/root/search(q='budget'), /me/messages/delta(), " +
        "/me/reminderView(startDateTime='…',endDateTime='…'). Put parameters in the path.",
      parameters: { type: "object", properties: { functionUrl: str("Relative Graph function path."), jsonBody: obj("Optional structured parameters (Work IQ provider functions only).") }, required: ["functionUrl"] },
      skipPermission: true,
      handler: async (a: { functionUrl: string; jsonBody?: unknown }) => guard(() => m365.fn(a.functionUrl, a.jsonBody)),
    }),
    defineTool("m365_create", {
      description:
        "Create a Microsoft 365 item by POSTing JSON to a collection: /me/messages creates a draft email (not sent), " +
        "/me/events creates a calendar event and invites any attendees, /me/todo/lists/{list-id}/tasks creates a task, " +
        "/chats/{chat-id}/messages posts a Teams chat message. Only use values the user gave you or that you read; never invent recipients or times.",
      parameters: { type: "object", properties: { parentUrl: str("Relative collection path."), jsonBody: obj("The new item.") }, required: ["parentUrl", "jsonBody"] },
      handler: async (a: { parentUrl: string; jsonBody: unknown }) => guard(() => m365.create(a.parentUrl, a.jsonBody)),
    }),
    defineTool("m365_update", {
      description: "Update a Microsoft 365 item with PATCH, e.g. mark mail read (/me/messages/{id} {\"isRead\":true}) or move a meeting. Pass If-Match in headers when the item has an @odata.etag.",
      parameters: { type: "object", properties: { entityUrl: str("Relative item path."), jsonBody: obj("Fields to change."), headers: headersSchema }, required: ["entityUrl", "jsonBody"] },
      handler: async (a: { entityUrl: string; jsonBody: unknown; headers?: Record<string, unknown> }) => guard(() => m365.update(a.entityUrl, a.jsonBody, a.headers)),
    }),
    defineTool("m365_delete", {
      description: "Delete a Microsoft 365 item (HTTP DELETE). Only delete what the user explicitly asked you to remove.",
      parameters: { type: "object", properties: { entityUrl: str("Relative item path."), headers: headersSchema }, required: ["entityUrl"] },
      handler: async (a: { entityUrl: string; headers?: Record<string, unknown> }) => guard(() => m365.remove(a.entityUrl, a.headers)),
    }),
    defineTool("m365_action", {
      description:
        "Run a Microsoft Graph action (POST): /me/sendMail, /me/messages/{id}/reply | replyAll | forward | send | move, " +
        "/me/events/{id}/accept | decline | tentativelyAccept, /me/findMeetingTimes, /me/calendar/getSchedule, /search/query. " +
        "Pass {} as jsonBody for actions without parameters.",
      parameters: { type: "object", properties: { actionUrl: str("Relative action path."), jsonBody: obj("Action parameters, or {}.") }, required: ["actionUrl", "jsonBody"] },
      handler: async (a: { actionUrl: string; jsonBody?: unknown }) => guard(() => m365.action(a.actionUrl, a.jsonBody)),
    }),
    defineTool("m365_fetch_file", {
      description:
        "Download a file's contents from OneDrive/SharePoint/Teams into the working folder's Downloads and return the saved path, " +
        "e.g. /me/drive/items/{item-id}/content or /drives/{drive-id}/items/{item-id}/content. Use format 'pdf' to convert Office files.",
      parameters: { type: "object", properties: { path: str("Relative Graph content path."), format: str("Optional conversion format, e.g. pdf.") }, required: ["path"] },
      skipPermission: true,
      handler: async (a: { path: string; format?: string }) => saveFile(ctx, a.path, a.format),
    }),
  ];

  // Work IQ adds schema/path discovery, plus natural-language ask/retrieve when the user has an M365 Copilot licence.
  for (const t of m365.workIqExtras()) {
    const name = TOOL_ALIASES[t.name] ?? `m365_${t.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const s: any = structuredClone(t.inputSchema ?? { type: "object", properties: {} });
    if (!settings.get().m365.copilotLicense && s.properties) {
      delete s.properties.agentId;
      delete s.properties.includeDeveloperCard;
    }
    tools.push(
      defineTool(name, {
        description: t.description ?? name,
        parameters: s,
        skipPermission: true,
        handler: async (args: Record<string, unknown>) => {
          try {
            const res = await m365.workiq.call(t.name, args, t.name === "ask" || t.name === "retrieve" ? 300_000 : 120_000);
            const text = (res.content ?? []).map((c) => c.text ?? "").join("\n") || JSON.stringify(res.structuredContent ?? "");
            return toResult({ ok: !res.isError, text });
          } catch (err) {
            return { textResultForLlm: `Work IQ error: ${errorMessage(err)}`, resultType: "failure" as const, error: errorMessage(err) };
          }
        },
      }),
    );
  }
  return tools;
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

async function saveFile(ctx: ToolContext, graphPath: string, format?: string): Promise<ToolResultObject> {
  const r = await ctx.m365.download(graphPath, format);
  if (!r.ok || !r.bytes) return { textResultForLlm: `Couldn't download the file: ${r.error ?? "unknown error"}`, resultType: "failure", error: r.error };
  const mime = r.contentType || "application/octet-stream";
  const base = (r.fileName || path.basename(String(graphPath).split("?")[0]) || "file").replace(/\$value|^content$/gi, "file");
  let fileName = base.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 120) || "file";
  if (format === "pdf" && path.extname(fileName).toLowerCase() !== ".pdf") fileName = `${path.parse(fileName).name}.pdf`;
  if (!path.extname(fileName) && EXT_BY_MIME[mime]) fileName += EXT_BY_MIME[mime];
  const dir = path.join(ctx.settings.get().workingDirectory, "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, fileName);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.parse(fileName).name} (${i})${path.extname(fileName)}`);
  fs.writeFileSync(target, r.bytes);
  const isImage = /^image\/(png|jpe?g|gif|webp)$/.test(mime) && r.bytes.length < 3_500_000;
  return {
    textResultForLlm: `Saved ${r.bytes.length.toLocaleString()} bytes (${mime}) to ${target}`,
    resultType: "success",
    ...(isImage ? { binaryResultsForLlm: [{ type: "image" as const, data: r.bytes.toString("base64"), mimeType: mime }] } : {}),
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
      "Search the user's Microsoft 365 content with Microsoft Search (no Microsoft 365 Copilot licence needed). " +
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
            const res = await ctx.m365.action("/search/query", { requests: [{ entityTypes: [type], query: { queryString: args.query }, from, size }] });
            const container = findHitsContainer(res.json ?? parseJsonSafe(res.text));
            if (!res.ok || !container) return `${label}\nNo results or error: ${truncate(res.text, 300)}`;
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
