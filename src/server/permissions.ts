import path from "node:path";
import type { PermissionRequest } from "@github/copilot-sdk";
import { isM365ReadOnly } from "./m365.js";
import { truncate } from "./util.js";

export interface PermissionSummary {
  kind: string;
  title: string;
  detail: string;
  intention?: string;
  readOnly: boolean;
  /** Key used to remember "allow for this conversation" decisions. */
  key: string;
  allowSession: boolean;
  risk: "low" | "medium" | "high";
  toolName?: string;
}

const APP_TOOL_TITLES: Record<string, string> = {
  automation_create: "Create an automation",
  automation_update: "Update an automation",
  automation_delete: "Delete an automation",
  automation_run_now: "Run an automation now",
  skill_save: "Save a skill (instructions used in future conversations)",
  app_update_settings: "Change OpenScout settings",
};

/** Lets the classifier look at the automation a tool call targets. */
export interface AppToolContext {
  automationAllowsActions(idOrName: string): boolean | undefined;
}

function classifyAppTool(name: string, args: Record<string, unknown>, ctx?: AppToolContext): Pick<PermissionSummary, "readOnly" | "risk" | "allowSession"> {
  const targetPrivileged = typeof args.id === "string" ? ctx?.automationAllowsActions(args.id) === true : false;
  switch (name) {
    case "automation_create":
      return args.allowActions === true ? { readOnly: false, risk: "high", allowSession: false } : { readOnly: true, risk: "low", allowSession: true };
    case "automation_update": {
      // Effective state after the update: omitted allowActions keeps the current value.
      const escalated = args.allowActions === true || (args.allowActions === undefined && targetPrivileged);
      return escalated ? { readOnly: false, risk: "high", allowSession: false } : { readOnly: true, risk: "low", allowSession: true };
    }
    case "automation_run_now":
      return targetPrivileged ? { readOnly: false, risk: "high", allowSession: false } : { readOnly: true, risk: "low", allowSession: true };
    case "automation_delete":
    case "skill_save":
    case "app_update_settings":
      return { readOnly: false, risk: "medium", allowSession: true };
    default:
      return { readOnly: true, risk: "low", allowSession: true };
  }
}

const ACTION_TITLES: Record<string, string> = {
  sendmail: "Send an email",
  reply: "Reply to an email",
  replyall: "Reply all to an email",
  forward: "Forward an email",
  createreply: "Create a reply draft",
  createreplyall: "Create a reply-all draft",
  createforward: "Create a forward draft",
  send: "Send a draft email",
  accept: "Accept a meeting invitation",
  decline: "Decline a meeting invitation",
  tentativelyaccept: "Tentatively accept a meeting",
  cancel: "Cancel a meeting",
  move: "Move an item",
  copy: "Copy an item",
  snoozereminder: "Snooze a reminder",
  dismissreminder: "Dismiss a reminder",
};

export function jsonPreview(v: unknown, max = 3000): string {
  if (v === undefined || v === null) return "";
  let text: string;
  if (typeof v === "string") {
    try {
      text = JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      text = v;
    }
  } else {
    text = JSON.stringify(v, null, 2);
  }
  return truncate(text, max);
}

function m365Title(tool: string, args: Record<string, unknown>): string {
  const url = String(args.actionUrl ?? args.parentUrl ?? args.entityUrl ?? "");
  if (tool === "m365_action") {
    const seg = url.split("?")[0].split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
    return ACTION_TITLES[seg] ?? `Microsoft 365 action: ${seg || url}`;
  }
  if (tool === "m365_create") {
    if (/\/chats\/[^/]+\/messages|\/channels\/[^/]+\/messages|\/replies$/i.test(url)) return "Post a Teams message";
    if (/\/messages\/?$/i.test(url)) return "Create an email draft";
    if (/\/events\/?$/i.test(url)) return "Create a calendar event (invites go to any attendees)";
    if (/\/todo\//i.test(url)) return "Create a To Do task";
    return "Create a Microsoft 365 item";
  }
  if (tool === "m365_update") return "Update a Microsoft 365 item";
  if (tool === "m365_delete") return "Delete a Microsoft 365 item";
  return `Microsoft 365: ${tool.replace(/^m365_/, "")}`;
}

function m365Detail(tool: string, args: Record<string, unknown>): string {
  const method = tool === "m365_update" ? "PATCH" : tool === "m365_delete" ? "DELETE" : "POST";
  const url = String(args.actionUrl ?? args.parentUrl ?? args.entityUrl ?? "");
  const body = args.jsonBody !== undefined ? `\n\n${jsonPreview(args.jsonBody, 6000)}` : "";
  return `${method} ${url}${body}`;
}

export function summarizePermission(req: PermissionRequest, appCtx?: AppToolContext): PermissionSummary {
  const r = req as any;
  switch (r.kind) {
    case "shell": {
      const cmds: { identifier: string; readOnly: boolean }[] = r.commands ?? [];
      const readOnly = cmds.length > 0 && cmds.every((c) => c.readOnly) && !r.hasWriteFileRedirection;
      return {
        kind: "shell",
        title: "Run a shell command",
        detail: r.fullCommandText ?? "",
        intention: r.intention,
        readOnly,
        key: `shell:${cmds.map((c) => c.identifier.toLowerCase()).sort().join("+")}`,
        allowSession: r.canOfferSessionApproval !== false && cmds.length > 0,
        risk: readOnly ? "low" : "high",
        toolName: "shell",
      };
    }
    case "write":
      return {
        kind: "write",
        title: "Create or edit a file",
        detail: `${r.fileName ?? ""}\n\n${truncate(r.diff || r.newFileContents || "", 6000)}`,
        intention: r.intention,
        readOnly: false,
        key: `write:${path.dirname(String(r.fileName ?? "")).toLowerCase()}`,
        allowSession: true,
        risk: "medium",
      };
    case "read":
      return { kind: "read", title: "Read a file or folder", detail: r.path ?? "", intention: r.intention, readOnly: true, key: "read", allowSession: true, risk: "low" };
    case "url": {
      let host = String(r.url ?? "");
      try {
        host = new URL(r.url).host;
      } catch {
        // keep raw value
      }
      return { kind: "url", title: "Fetch a web page", detail: r.url ?? "", intention: r.intention, readOnly: true, key: `url:${host}`, allowSession: true, risk: "low" };
    }
    case "mcp":
      return {
        kind: "mcp",
        title: `${r.serverName}: ${r.toolTitle || r.toolName}`,
        detail: jsonPreview(r.args),
        readOnly: Boolean(r.readOnly),
        key: `mcp:${r.serverName}:${r.toolName}`,
        allowSession: true,
        risk: r.readOnly ? "low" : "medium",
        toolName: r.toolName,
      };
    case "custom-tool": {
      const name = String(r.toolName ?? "");
      const args = (r.args && typeof r.args === "object" ? r.args : {}) as Record<string, unknown>;
      if (name.startsWith("m365_")) {
        const readOnly = isM365ReadOnly(name, args);
        return {
          kind: "m365",
          title: m365Title(name, args),
          detail: m365Detail(name, args),
          readOnly,
          key: `m365:${name}`,
          // Never remember approvals for writes to Microsoft 365: every send/change is confirmed.
          allowSession: false,
          risk: readOnly ? "low" : "high",
          toolName: name,
        };
      }
      const cls = classifyAppTool(name, args, appCtx);
      return {
        kind: "custom-tool",
        title: APP_TOOL_TITLES[name] ?? `Use ${name}`,
        detail: jsonPreview(args),
        ...cls,
        key: `custom:${name}`,
        toolName: name,
      };
    }
    case "memory":
      return { kind: "memory", title: "Use Copilot memory", detail: jsonPreview(r), readOnly: true, key: "memory", allowSession: true, risk: "low" };
    default:
      return { kind: String(r.kind), title: `Permission: ${r.kind}`, detail: jsonPreview(r), readOnly: false, key: `other:${r.kind}`, allowSession: false, risk: "medium" };
  }
}

/**
 * True when a shell request is a single, plain invocation of allow-listed commands with literal arguments.
 * Anything that could evaluate code (subexpressions, .NET member calls, variables, script blocks, pipes,
 * redirection, escapes) is rejected so it falls back to a normal approval prompt.
 */
export function shellAllowed(req: PermissionRequest, patterns: string[]): boolean {
  const r = req as any;
  if (r.kind !== "shell" || r.hasWriteFileRedirection || !patterns.length) return false;
  const text = String(r.fullCommandText ?? "").trim();
  if (!text || !/^[A-Za-z0-9\s\-_.\/\\:*?~,'"=+#]+$/.test(text)) return false;
  // Double-quoted strings may only hold literal characters (no $ or backtick, enforced above), so they're inert.
  const pats = patterns.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const allowedIds = new Set(pats.map((p) => p.split(/\s+/)[0]));
  const ids: string[] = (r.commands ?? []).map((c: any) => String(c.identifier).toLowerCase());
  if (ids.length !== 1 || !allowedIds.has(ids[0])) return false;
  const lower = text.toLowerCase();
  return pats.some((p) => lower === p || lower.startsWith(`${p} `));
}
