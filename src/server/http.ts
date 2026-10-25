import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ASSETS_DIR, NODE_MODULES, WEB_DIR } from "./paths.js";
import { Bus, errorMessage, log, type BroadcastMessage } from "./util.js";

export interface ClientContext {
  id: number;
}

type Handler = (method: string, params: any, client: ClientContext) => Promise<unknown>;

const VENDOR: Record<string, string> = {
  "marked.js": "marked/lib/marked.umd.js",
  "purify.js": "dompurify/dist/purify.min.js",
  "highlight.js": "@highlightjs/cdn-assets/highlight.min.js",
  "hljs-light.css": "@highlightjs/cdn-assets/styles/github.min.css",
  "hljs-dark.css": "@highlightjs/cdn-assets/styles/github-dark.min.css",
  "mermaid.js": "mermaid/dist/mermaid.min.js",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".json": "application/json",
};
const LOCAL_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

/**
 * Serves the UI and a token-protected WebSocket RPC channel on 127.0.0.1 only.
 * Host and Origin are validated to block DNS-rebinding and cross-site WebSocket hijacking.
 */
export class HttpServer {
  port = 0;
  private readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private nextClientId = 1;

  constructor(
    private readonly token: string,
    private readonly bus: Bus,
    private readonly handler: Handler,
    private readonly state: () => unknown,
  ) {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = req.headers.origin;
      const okOrigin = !origin || this.allowedOrigin(origin);
      if (url.pathname !== "/ws" || !this.allowedHost(req.headers.host) || !okOrigin || url.searchParams.get("token") !== this.token) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    this.bus.on("broadcast", (msg: BroadcastMessage) => {
      const data = JSON.stringify(msg);
      for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) {
          log("http", `Port ${port} busy, using a random port`);
          this.server.listen(0, "127.0.0.1");
        } else reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", onError);
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
      this.server.once("listening", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private allowedHost(host?: string): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private allowedOrigin(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.allowedHost(req.headers.host)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "/index.html") {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          `connect-src 'self' ws://127.0.0.1:${this.port} ws://localhost:${this.port}`,
          "font-src 'self' data:",
          "object-src 'none'",
          "frame-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      );
      return this.sendFile(res, path.join(WEB_DIR, "index.html"));
    }
    if (pathname.startsWith("/vendor/")) {
      const rel = VENDOR[pathname.slice("/vendor/".length)];
      if (!rel) return void res.writeHead(404).end();
      return this.sendFile(res, path.join(NODE_MODULES, rel));
    }
    if (pathname.startsWith("/assets/")) return this.sendStatic(res, ASSETS_DIR, pathname.slice("/assets/".length));
    if (pathname === "/local-file") {
      // Lets the chat render images the agent saved locally (file:/// links are rewritten to this route).
      if (url.searchParams.get("token") !== this.token) return void res.writeHead(403).end();
      const file = path.resolve(url.searchParams.get("path") ?? "");
      if (!LOCAL_IMAGE_EXT.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) return void res.writeHead(404).end();
      // Untrusted content: if opened directly (e.g. an SVG in a new tab) it gets an opaque origin and no script.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      return this.sendFile(res, file);
    }
    return this.sendStatic(res, WEB_DIR, pathname.replace(/^\/+/, ""));
  }

  private sendStatic(res: http.ServerResponse, root: string, rel: string): void {
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) return void res.writeHead(403).end();
    this.sendFile(res, file);
  }

  private sendFile(res: http.ServerResponse, file: string): void {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return void res.writeHead(404).end("Not found");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Length": st.size });
      fs.createReadStream(file).pipe(res);
    });
  }

  private onConnection(ws: WebSocket): void {
    const client: ClientContext = { id: this.nextClientId++ };
    ws.send(JSON.stringify({ event: "hello", payload: this.state() }));
    ws.on("message", async (raw) => {
      let msg: { id?: number; method?: string; params?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg.method !== "string") return;
      try {
        const result = await this.handler(msg.method, msg.params, client);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
      } catch (err) {
        log("rpc", `${msg.method} failed:`, errorMessage(err));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ok: false, error: errorMessage(err) }));
      }
    });
  }
}
