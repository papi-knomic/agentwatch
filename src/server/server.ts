import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../core/config.js";
import { APP_NAME, MAX_EVENT_BODY_BYTES } from "../core/constants.js";
import type { SessionStore, StoreChange } from "../core/store.js";
import { parseAgentEvent, type Session } from "../core/types.js";
import { type SetupService, UnknownToolError } from "./setup.js";
import { serveStatic } from "./static.js";

export interface ToolInfo {
  id: string;
  label: string;
  color: string;
}

export interface AppServerOptions {
  config: Config;
  store: SessionStore;
  tools: ToolInfo[];
  staticDir: string;
  version: string;
  /** Takes the user to a session (e.g. its VS Code tab); returns false if it can't be opened. */
  openSession?: (session: Session) => boolean;
  /** Connection status and one-click connect for the landing page. */
  setup?: SetupService;
  /** Called after answering POST /api/shutdown (`agentwatch stop`). */
  onShutdown?: () => void;
}

const SSE_HEARTBEAT_MS = 25_000;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_EVENT_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function readSessionKey(req: IncomingMessage): Promise<string> {
  const body = await readJsonBody(req);
  const key = typeof body === "object" && body !== null ? (body as { key?: unknown }).key : undefined;
  if (typeof key !== "string") throw new HttpError(400, "Missing key");
  return key;
}

function tokenMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function createAppServer(options: AppServerOptions): Server {
  const { config, store } = options;

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 500, { error: "Internal error" });
    });
  });

  function port(): number {
    return (server.address() as AddressInfo | null)?.port ?? config.port;
  }

  function allowedHosts(): string[] {
    return [`127.0.0.1:${port()}`, `localhost:${port()}`];
  }

  function allowedOrigins(): string[] {
    return allowedHosts().map((host) => `http://${host}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Rejects DNS-rebinding attacks, where a malicious site resolves its own hostname to 127.0.0.1.
    if (!allowedHosts().includes(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");

    const origin = req.headers.origin;
    const sameOrigin = origin !== undefined && allowedOrigins().includes(origin);
    // Any page in the user's browser can send requests here; only our own dashboard may write.
    if (req.method !== "GET" && req.method !== "HEAD" && origin !== undefined && !sameOrigin) {
      throw new HttpError(403, "Forbidden origin");
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /api/health":
        return sendJson(res, 200, { ok: true, app: APP_NAME, version: options.version });

      case "GET /api/state":
        return sendJson(res, 200, { sessions: store.list(), tools: options.tools });

      case "GET /api/stream":
        return stream(req, res);

      case "POST /api/events": {
        if (!tokenMatches(req, config.token)) throw new HttpError(401, "Missing or invalid token");
        const event = parseAgentEvent(await readJsonBody(req));
        if (!event) throw new HttpError(400, "Invalid event");
        store.apply(event);
        return sendJson(res, 202, { ok: true });
      }

      case "POST /api/sessions/dismiss": {
        if (!sameOrigin && !tokenMatches(req, config.token)) throw new HttpError(403, "Forbidden");
        store.remove(await readSessionKey(req));
        return sendJson(res, 200, { ok: true });
      }

      case "POST /api/sessions/open": {
        // Launches local apps, so it gets the same origin/token check as any other write.
        if (!sameOrigin && !tokenMatches(req, config.token)) throw new HttpError(403, "Forbidden");
        const session = store.get(await readSessionKey(req));
        if (!session) throw new HttpError(404, "Unknown session");
        if (!options.openSession?.(session)) throw new HttpError(409, "This session can't be opened");
        return sendJson(res, 200, { ok: true });
      }

      case "GET /api/setup": {
        if (!options.setup) throw new HttpError(404, "Not found");
        return sendJson(res, 200, await options.setup.status());
      }

      case "POST /api/setup/connect": {
        // Edits the user's agent configs: only our own dashboard may ask, never a token-holding script.
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        if (!options.setup) throw new HttpError(404, "Not found");
        const body = await readJsonBody(req);
        const { tool, dryRun } = (typeof body === "object" && body !== null ? body : {}) as {
          tool?: unknown;
          dryRun?: unknown;
        };
        if (typeof tool !== "string") throw new HttpError(400, "Missing tool");
        try {
          return sendJson(res, 200, await options.setup.connect(tool, dryRun === true));
        } catch (error) {
          if (error instanceof UnknownToolError) throw new HttpError(400, error.message);
          throw new HttpError(500, error instanceof Error ? error.message : String(error));
        }
      }

      case "POST /api/shutdown": {
        // Only the CLI (which can read the token) may stop the server, not a web page.
        if (origin !== undefined || !tokenMatches(req, config.token)) throw new HttpError(403, "Forbidden");
        sendJson(res, 200, { ok: true });
        options.onShutdown?.();
        return;
      }

      default:
        if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        return serveStatic(options.staticDir, url.pathname, res);
    }
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { sessions: store.list(), tools: options.tools });

    const unsubscribe = store.subscribe((change: StoreChange) => {
      if (change.type === "upsert") send("upsert", change.session);
      else send("remove", { key: change.key });
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  return server;
}
