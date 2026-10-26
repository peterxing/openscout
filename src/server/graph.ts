import path from "node:path";
import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import { paths } from "./paths.js";
import type { SettingsStore } from "./settings.js";
import { Bus, errorMessage, log } from "./util.js";

/**
 * Microsoft's public client for Microsoft Graph PowerShell / CLI. It supports interactive delegated sign-in
 * from desktop apps in most tenants, so OpenScout can work with nothing more than a Microsoft 365 account.
 * Organisations can register their own app instead (Settings → Microsoft 365 → Sign-in app).
 */
export const QUICK_START_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const QUICK_START_NAME = "Microsoft Graph Command Line Tools";

const GRAPH_HOST = "https://graph.microsoft.com";
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Delegated permissions that users can normally consent to themselves (no Microsoft 365 Copilot licence involved). */
export const BASE_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Files.ReadWrite.All",
  "Sites.Read.All",
  "Chat.ReadWrite",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "People.Read",
  "Tasks.ReadWrite",
  "Presence.Read",
];

/** Optional permission groups. These need an administrator to grant consent for the organisation. */
export const SCOPE_GROUPS: Record<string, { label: string; scopes: string[] }> = {
  channels: { label: "Teams channel messages", scopes: ["ChannelMessage.Read.All"] },
  education: { label: "Class assignments and rosters (Teams for Education)", scopes: ["EduAssignments.ReadBasic", "EduRoster.ReadBasic"] },
};

/** Request headers the model may set; everything else (notably Authorization) is dropped. */
const ALLOWED_HEADERS = new Set(["if-match", "prefer", "consistencylevel"]);

export interface GraphUser {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
}

export interface GraphStatus {
  state: "starting" | "ready" | "signed-out" | "signing-in" | "error";
  user?: GraphUser;
  message?: string;
  signInApp: string;
  clientId: string;
  tenant: string;
  scopes: string[];
}

export interface GraphResponse {
  path: string;
  statusCode: number;
  data?: unknown;
  error?: unknown;
}

export interface GraphDownload {
  statusCode: number;
  bytes?: Buffer;
  contentType?: string;
  fileName?: string;
  error?: string;
}

export class SignInRequiredError extends Error {}

const SUCCESS_HTML =
  '<!doctype html><html><body style="font-family:Segoe UI,system-ui,sans-serif;text-align:center;padding:48px">' +
  "<h2>You're signed in to OpenScout</h2><p>You can close this tab and go back to the app.</p></body></html>";
const ERROR_HTML =
  '<!doctype html><html><body style="font-family:Segoe UI,system-ui,sans-serif;text-align:center;padding:48px">' +
  "<h2>Sign-in didn't complete</h2><p>Go back to OpenScout for details. If it says an administrator must approve the app, ask your IT team.</p></body></html>";

/** Turns a model-supplied path such as /me/messages?$top=5 into an absolute Microsoft Graph URL (v1.0 unless /beta/). */
export function graphUrl(raw: string): URL {
  let p = String(raw ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//")) throw new Error(`Microsoft Graph paths must be relative, like /me/messages (got "${p.slice(0, 80)}").`);
  if (/[\r\n]/.test(p)) throw new Error("Microsoft Graph paths can't contain line breaks.");
  if (!/^\/(v1\.0|beta)(\/|$)/.test(p)) p = `/v1.0${p}`;
  const url = new URL(GRAPH_HOST + p);
  if (url.origin !== GRAPH_HOST) throw new Error("Only Microsoft Graph paths are allowed.");
  return url;
}

export function graphErrorText(r: { statusCode: number; error?: unknown }): string {
  const e = (r.error as { error?: { code?: string; message?: string } } | undefined)?.error;
  const base = e?.message ? `${e.code ?? "Error"}: ${e.message}` : typeof r.error === "string" ? r.error.slice(0, 300) : "";
  const hint =
    r.statusCode === 403
      ? " (your sign-in lacks permission for this — some areas, such as Teams channel messages or class assignments, need an administrator to approve them in Settings → Microsoft 365)"
      : r.statusCode === 404
        ? " (not found — check the ID or path)"
        : "";
  return `HTTP ${r.statusCode}${base ? ` ${base}` : ""}${hint}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

function fileNameFromDisposition(cd: string | null): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain filename parameter
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1]?.trim();
}

/**
 * Direct Microsoft Graph access with the user's own delegated sign-in (MSAL, system browser).
 * Tokens are cached on disk encrypted for the current user (DPAPI on Windows, Keychain on macOS).
 */
export class GraphService {
  status: GraphStatus;
  private pca: PublicClientApplication | null = null;
  private pcaKey = "";
  private account: AccountInfo | null = null;
  private starting: Promise<void> | null = null;
  private signingIn: Promise<GraphStatus> | null = null;

  constructor(
    private readonly bus: Bus,
    private readonly settings: SettingsStore,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {
    this.status = this.makeStatus("starting");
  }

  clientId(): string {
    return this.settings.get().m365.clientId || QUICK_START_CLIENT_ID;
  }

  tenant(): string {
    return this.settings.get().m365.tenant || "organizations";
  }

  scopes(): string[] {
    const extra = this.settings.get().m365.scopeGroups.flatMap((g) => SCOPE_GROUPS[g]?.scopes ?? []);
    return [...new Set([...BASE_SCOPES, ...extra])];
  }

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async whenSettled(timeoutMs = 20_000): Promise<void> {
    const pending = this.starting;
    if (!pending) return;
    await Promise.race([pending.catch(() => undefined), sleep(timeoutMs)]);
  }

  private async doStart(): Promise<void> {
    this.setStatus("starting");
    try {
      const pca = await this.client();
      this.account = (await pca.getTokenCache().getAllAccounts())[0] ?? null;
      if (!this.account) {
        this.setStatus("signed-out", { message: "Sign in with your Microsoft 365 work or school account." });
        return;
      }
      await this.refreshStatus();
    } catch (err) {
      this.setStatus("error", { message: errorMessage(err) });
    }
  }

  /** Confirms the cached sign-in works by reading the user's profile. */
  async refreshStatus(): Promise<GraphStatus> {
    try {
      const me = await this.request("GET", "/me?$select=displayName,mail,userPrincipalName,jobTitle");
      if (me.statusCode === 200) this.setStatus("ready", { user: me.data as GraphUser });
      else this.setStatus(me.statusCode === 401 ? "signed-out" : "error", { message: graphErrorText(me) });
    } catch (err) {
      this.setStatus(err instanceof SignInRequiredError ? "signed-out" : "error", { message: errorMessage(err) });
    }
    return this.status;
  }

  /** Interactive sign-in in the system browser; resolves when the user finishes (or after 5 minutes). */
  signIn(): Promise<GraphStatus> {
    if (this.signingIn) return this.signingIn;
    this.signingIn = (async () => {
      this.setStatus("signing-in", { message: "Finish signing in in your browser…" });
      try {
        const pca = await this.client();
        const result = await withTimeout(
          pca.acquireTokenInteractive({
            scopes: this.scopes(),
            prompt: "select_account",
            openBrowser: (url) => this.openUrl(url),
            successTemplate: SUCCESS_HTML,
            errorTemplate: ERROR_HTML,
          }),
          5 * 60_000,
          "Sign-in timed out after 5 minutes. Try again.",
        );
        this.account = result.account;
        log("graph", `signed in as ${result.account?.username ?? "unknown"}`);
        return await this.refreshStatus();
      } catch (err) {
        // MSAL keeps the server's error_description in errorMessage/subError; include them so AADSTS codes can be mapped.
        const e = err as { errorMessage?: string; subError?: string };
        const msg = [errorMessage(err), e?.errorMessage, e?.subError].filter(Boolean).join(" ");
        log("graph", "sign-in failed:", msg);
        this.setStatus(this.account ? "error" : "signed-out", { message: friendlyAuthError(msg) });
        return this.status;
      } finally {
        this.signingIn = null;
      }
    })();
    return this.signingIn;
  }

  async signOut(): Promise<GraphStatus> {
    const pca = await this.client();
    const cache = pca.getTokenCache();
    for (const a of await cache.getAllAccounts()) await cache.removeAccount(a);
    this.account = null;
    this.setStatus("signed-out", { message: "Signed out of Microsoft 365." });
    return this.status;
  }

  async request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", rawPath: string, body?: unknown, headers: Record<string, unknown> = {}): Promise<GraphResponse> {
    const url = graphUrl(rawPath);
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) if (ALLOWED_HEADERS.has(k.toLowerCase()) && typeof v === "string") extra[k] = v;
    // Directory queries with $search/$count need eventual consistency.
    if (/\/(users|groups|directoryObjects)\b|memberOf|directReports/i.test(url.pathname) && /\$(search|count)/i.test(url.search)) extra.ConsistencyLevel ??= "eventual";
    let token = await this.token();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 401 && attempt === 0) {
        token = await this.token(true);
        continue;
      }
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
        await sleep(Math.min(30, Number(res.headers.get("retry-after")) || 2 ** (attempt + 1)) * 1000);
        continue;
      }
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return res.ok ? { path: rawPath, statusCode: res.status, data: parsed ?? null } : { path: rawPath, statusCode: res.status, error: parsed };
    }
  }

  /** Downloads file content (e.g. /me/drive/items/{id}/content). Graph redirects to a pre-authorised URL; fetch drops our token on that hop. */
  async download(rawPath: string, format?: string): Promise<GraphDownload> {
    const url = graphUrl(rawPath);
    if (format) url.searchParams.set("format", format);
    const token = await this.token();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow", signal: AbortSignal.timeout(300_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let error: unknown = text;
      try {
        error = JSON.parse(text);
      } catch {
        // keep text
      }
      return { statusCode: res.status, error: graphErrorText({ statusCode: res.status, error }) };
    }
    if (Number(res.headers.get("content-length") || 0) > MAX_DOWNLOAD_BYTES) return { statusCode: 413, error: "File is larger than 200 MB." };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) return { statusCode: 413, error: "File is larger than 200 MB." };
    return {
      statusCode: res.status,
      bytes,
      contentType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
      fileName: fileNameFromDisposition(res.headers.get("content-disposition")),
    };
  }

  private async client(): Promise<PublicClientApplication> {
    const key = `${this.clientId()}|${this.tenant()}`;
    if (this.pca && this.pcaKey === key) return this.pca;
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: path.join(paths.data, "m365-token-cache.bin"),
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "OpenScout",
      accountName: "m365-token-cache",
      usePlaintextFileOnLinux: false,
    });
    this.pca = new PublicClientApplication({
      auth: { clientId: this.clientId(), authority: `https://login.microsoftonline.com/${this.tenant()}` },
      cache: { cachePlugin: new PersistenceCachePlugin(persistence) },
    });
    this.pcaKey = key;
    this.account = null;
    return this.pca;
  }

  private async token(forceRefresh = false): Promise<string> {
    const pca = await this.client();
    if (!this.account) this.account = (await pca.getTokenCache().getAllAccounts())[0] ?? null;
    if (!this.account) throw new SignInRequiredError("You're not signed in to Microsoft 365. Sign in under Settings → Microsoft 365.");
    try {
      return (await pca.acquireTokenSilent({ account: this.account, scopes: this.scopes(), forceRefresh })).accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        const msg = "Your Microsoft 365 sign-in expired or needs new permissions. Sign in again under Settings → Microsoft 365.";
        this.setStatus("signed-out", { message: msg });
        throw new SignInRequiredError(msg);
      }
      throw err;
    }
  }

  private makeStatus(state: GraphStatus["state"], extra: Partial<GraphStatus> = {}): GraphStatus {
    const custom = Boolean(this.settings.get().m365.clientId);
    return {
      state,
      signInApp: custom ? "Your organisation's app registration" : QUICK_START_NAME,
      clientId: this.clientId(),
      tenant: this.tenant(),
      scopes: this.scopes(),
      ...extra,
    };
  }

  private setStatus(state: GraphStatus["state"], extra: Partial<GraphStatus> = {}): void {
    this.status = this.makeStatus(state, extra);
    this.bus.emit("graph.status", this.status);
  }
}

function friendlyAuthError(msg: string): string {
  if (/AADSTS65001|AADSTS90094|AADSTS90095|consent_required|admin.*(approv|consent)/i.test(msg)) {
    return "Your organisation requires an administrator to approve this app before you can use it. Ask your IT team to grant consent, or to give you their own app registration's client ID (Settings → Microsoft 365 → Sign-in app).";
  }
  if (/AADSTS50105|not assigned/i.test(msg)) return "Your account isn't assigned to this app in your organisation. Ask your IT team for access.";
  if (/AADSTS53003|conditional access/i.test(msg)) return "Your organisation's Conditional Access policies blocked this sign-in (for example, a managed device may be required).";
  if (/AADSTS65004|user_cancelled/i.test(msg)) return "Sign-in was cancelled.";
  if (/access_denied/i.test(msg)) {
    return "Sign-in didn't finish. If Microsoft said an administrator must approve the app, ask your IT team to approve it, or to give you their own app registration's client ID (Settings → Microsoft 365 → Sign-in app). Otherwise, try again.";
  }
  return msg.slice(0, 400);
}
