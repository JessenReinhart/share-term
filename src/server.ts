import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

export interface ServerOptions {
  /** Directory containing the static web app (index.html, etc.). */
  publicDir: string;
  /** TCP port to listen on. */
  port: number;
  /** Called once per newly connected phone client. */
  onConnection?: (ws: WebSocket) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/**
 * Lightweight HTTP + WebSocket server.
 *
 *  - Serves the static PWA from `publicDir` (no external framework needed).
 *  - Accepts WebSocket upgrades on the same port (so phones only need one URL).
 *  - Tracks connected clients and broadcasts JSON messages to all of them.
 *
 * Disconnections are handled defensively: broken sockets are removed from the
 * client set and send failures are swallowed so one bad client can't crash the
 * stream for everyone else.
 */
export class ShareServer {
  private server!: http.Server;
  private wss!: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly opts: ServerOptions) {}

  /** Start listening. Resolves once the socket is bound. */
  start(): Promise<void> {
    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);

      // Keep-alive: if the socket dies, drop it from the active set.
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => {
        this.clients.delete(ws);
        try {
          ws.terminate();
        } catch {
          /* already closed */
        }
      });
      ws.on("pong", () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      });

      this.opts.onConnection?.(ws);
    });

    // Heartbeat: terminate sockets that stop responding to pings.
    const heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        const sock = ws as WebSocket & { isAlive?: boolean };
        if (sock.isAlive === false) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        sock.isAlive = false;
        try {
          ws.ping();
        } catch {
          this.clients.delete(ws);
        }
      }
    }, 30_000);
    this.wss.on("close", () => clearInterval(heartbeat));

    return new Promise((resolve) => {
      this.server.listen(this.opts.port, () => resolve());
    });
  }

  /** Broadcast a JSON-serialisable message to every live client. */
  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  /** Number of currently connected phone clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Serve a static file from `publicDir`, preventing path traversal. */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const urlPath = (req.url ?? "/").split("?")[0] || "/";
    const decoded = decodeURIComponent(urlPath);
    // Root → index.html; otherwise drop leading slashes (OS-agnostic).
    const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    // Strip any leading "../" sequences to prevent directory traversal.
    const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(this.opts.publicDir, normalized);

    // Guard against escaping the public directory.
    const publicRoot = path.resolve(this.opts.publicDir);
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(content);
    });
  }

  stop(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.wss?.close();
    this.server?.close();
  }
}
