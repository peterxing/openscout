import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { APP_NAME, APP_VERSION } from "./paths.js";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal MCP client over newline-delimited JSON-RPC on stdio. */
export class McpStdioClient {
  tools: McpTool[] = [];
  serverInfo: { name?: string; version?: string } = {};
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string> = {},
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.boot();
    this.ready.catch(() => {
      this.ready = null;
      this.kill();
    });
    return this.ready;
  }

  private async boot(): Promise<void> {
    const proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...this.env },
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    const onGone = (reason: string) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited (${reason}). ${this.stderrTail.join("").slice(-500)}`.trim()));
        this.pending.delete(id);
      }
    };
    proc.on("exit", (code) => onGone(`code ${code}`));
    proc.on("error", (err) => onGone(err.message));

    const init = await this.request(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: APP_NAME, version: APP_VERSION } },
      60_000,
    );
    this.serverInfo = init?.serverInfo ?? {};
    this.notify("notifications/initialized", {});
    const list = await this.request("tools/list", {}, 60_000);
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
  }

  async callTool(name: string, args: unknown, timeoutMs = 120_000): Promise<McpCallResult> {
    await this.start();
    return (await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs)) as McpCallResult;
  }

  stop(): void {
    this.kill();
    this.ready = null;
  }

  private kill(): void {
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) p.kill();
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private respond(id: unknown, payload: { result?: unknown; error?: { code: number; message: string } }): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // Server-to-client request: answer the few we understand, refuse the rest.
        if (msg.method === "ping") this.respond(msg.id, { result: {} });
        else if (msg.method === "roots/list") this.respond(msg.id, { result: { roots: [] } });
        else this.respond(msg.id, { error: { code: -32601, message: `Unsupported method ${msg.method}` } });
        continue;
      }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }
}

export function mcpText(res: McpCallResult): string {
  const parts = (res.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "resource" ? (c.resource?.text ?? "") : ""))
    .filter(Boolean);
  if (parts.length) return parts.join("\n");
  if (res.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
  return "";
}
