import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Config, normalizeRemoteHost, type RemoteConfig } from "../core/config.js";
import { APP_NAME, MAX_EVENT_BODY_BYTES } from "../core/constants.js";
import { parseQuestions, truncate } from "../core/decision-types.js";
import { applyPhoneUpdate, type PhoneConfig, publicPhone } from "../core/phone.js";
import type { SessionStore, StoreChange } from "../core/store.js";
import { parseAgentEvent, type Session, sessionKey } from "../core/types.js";
import { DecisionStore } from "./decisions.js";
import {
  cleanDeviceName,
  type DeviceInfo,
  DeviceStore,
  deviceCookie,
  PairingCodes,
  type PairingOptions,
} from "./devices.js";
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
  /** Phone (ntfy) settings for the dashboard. Loopback only: the topic and token are secrets. */
  phone?: {
    get(): PhoneConfig;
    /** Persists and applies new settings (only the `phone` key of the config file). */
    set(next: PhoneConfig): Promise<void>;
    sendTest(): Promise<{ ok: boolean; error?: string }>;
  };
  /** Pending permission prompts and questions (in memory). A fresh one is created when omitted. */
  decisions?: DecisionStore;
  /** Paired phones for remote access (see AGENTS.md). In memory only when omitted. */
  devices?: DeviceStore;
  /** Pairing code limits; only tests change these. */
  pairing?: PairingOptions;
  /** Persists the remote-access settings (and nothing else) after the dashboard changes them. */
  saveRemote?: (remote: RemoteConfig) => Promise<void>;
  /** Finds this machine's Tailscale name, for the "Detect" button. */
  detectHost?: () => Promise<string | null>;
  /** Called after answering POST /api/shutdown (`agentwatch stop`). */
  onShutdown?: () => void;
  /** Presence timings in ms; only tests change these. */
  presence?: { ttlMs?: number; graceMs?: number };
}

const SSE_HEARTBEAT_MS = 25_000;
/** The longest a single decision long-poll may hold a request open. */
const MAX_WAIT_MS = 30_000;
/** Dashboards re-announce that they are visible this often; a viewer not heard from for PRESENCE_TTL_MS is not. */
const PRESENCE_TTL_MS = 60_000;
/** With nothing pending being looked at for this long, pending decisions are cancelled so the terminal prompt shows. */
const NO_VIEWER_GRACE_MS = 5_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_PATH = /^\/api\/devices\/([A-Za-z0-9_-]{8,32})$/;
const DECISION_PATH = /^\/api\/decisions\/([A-Za-z0-9_-]{1,64})\/(wait|resolve)$/;

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
  const decisions = options.decisions ?? new DecisionStore();
  // Dashboard tabs, by the random id each generates. Claude Code's own prompt can be held back while we wait for an
  // answer (the hook runs before the prompt), so a decision is only taken when a tab is connected AND visible.
  const viewers = new Map<
    string,
    { streams: Set<ServerResponse>; visibleAt: number | null; deviceId?: string }
  >();
  const devices = options.devices ?? new DeviceStore();
  const pairing = new PairingCodes(options.pairing);
  // Open remote streams (every remote stream belongs to a paired device), so revoking a device, turning remote access
  // off or removing a host cuts the affected connections at once.
  const deviceStreams = new Map<
    ServerResponse,
    { deviceId: string; host: string; clientId: string | null }
  >();
  const presenceTtlMs = options.presence?.ttlMs ?? PRESENCE_TTL_MS;
  const graceMs = options.presence?.graceMs ?? NO_VIEWER_GRACE_MS;
  let noViewerSince: number | null = null;

  function hasVisibleViewer(): boolean {
    const now = Date.now();
    for (const viewer of viewers.values()) {
      if (viewer.streams.size > 0 && viewer.visibleAt !== null && now - viewer.visibleAt < presenceTtlMs) {
        // A phone that can't answer prompts must not hold them back from the terminal.
        if (viewer.deviceId === undefined || devices.get(viewer.deviceId)?.allowApprovals) return true;
      }
    }
    return false;
  }

  // Nobody looking any more while a question or prompt is pending: let the terminal show it instead.
  function checkViewers(): void {
    if (decisions.list().length === 0 || hasVisibleViewer()) {
      noViewerSince = null;
      return;
    }
    const now = Date.now();
    noViewerSince ??= now;
    if (now - noViewerSince >= graceMs) {
      noViewerSince = null;
      decisions.cancelPending();
    }
  }
  const sweep = setInterval(checkViewers, Math.min(1000, Math.max(20, graceMs / 2)));
  sweep.unref();
  // The user answering in the terminal shows up as newer activity on the session.
  store.subscribe((change) => decisions.handleSessionChange(change));

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
      else sendJson(res, 500, { error: "Internal error" });
    });
  });

  server.on("close", () => clearInterval(sweep));

  /** Closes the matching remote streams and forgets the dashboards they made visible. */
  function dropRemoteStreams(match: (info: { deviceId: string; host: string }) => boolean): void {
    for (const [stream, info] of [...deviceStreams]) {
      if (!match(info)) continue;
      deviceStreams.delete(stream);
      const viewer = info.clientId === null ? undefined : viewers.get(info.clientId);
      if (viewer && info.clientId !== null) {
        viewer.streams.delete(stream);
        if (viewer.streams.size === 0) viewers.delete(info.clientId);
      }
      stream.destroy();
    }
    checkViewers();
  }

  function port(): number {
    return (server.address() as AddressInfo | null)?.port ?? config.port;
  }

  function allowedHosts(): string[] {
    return [`127.0.0.1:${port()}`, `localhost:${port()}`];
  }

  function allowedOrigins(): string[] {
    return allowedHosts().map((host) => `http://${host}`);
  }

  /** The configured remote host this Host header names (with no port or :443), or null. Off means always null. */
  function remoteHostFor(hostHeader: string): string | null {
    const remote = config.remote;
    if (!remote?.enabled) return null;
    const lower = hostHeader.toLowerCase();
    return remote.hosts.find((h) => lower === h || lower === `${h}:443`) ?? null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Rejects DNS-rebinding attacks, where a malicious site resolves its own hostname to 127.0.0.1. Only the
    // configured remote hosts (a user-run HTTPS proxy such as Tailscale Serve) are accepted besides loopback.
    const remoteHost = remoteHostFor(req.headers.host ?? "");
    const remote = remoteHost !== null;
    if (!remote && !allowedHosts().includes(req.headers.host ?? ""))
      throw new HttpError(403, "Forbidden host");

    const origin = req.headers.origin;
    // A remote request is "same origin" only with its own https origin, a loopback one only with a loopback origin.
    const ownOrigins = remote ? [`https://${remoteHost}`] : allowedOrigins();
    const sameOrigin = origin !== undefined && ownOrigins.includes(origin);
    // The token never works through the proxy: a phone is paired with a cookie and never holds the token.
    const hasToken = () => !remote && tokenMatches(req, config.token);
    // Everything that touches this PC (setup, opening apps, device management, shutdown) is loopback only.
    const localOnly = () => {
      if (remote) throw new HttpError(403, "Not available remotely");
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    // Any page in the user's browser can send requests here. Writes need our own origin (or no Origin at all, i.e.
    // not a browser, plus the token where required). Reads of /api/* are refused to foreign pages too: a foreign
    // EventSource would otherwise count as a viewer, and state can include a command preview or a question.
    const isRead = req.method === "GET" || req.method === "HEAD";
    const guardedRead = url.pathname.startsWith("/api/") && url.pathname !== "/api/health";
    if (origin !== undefined && !sameOrigin && (!isRead || guardedRead)) {
      throw new HttpError(403, "Forbidden origin");
    }
    // Remote browsers must send their own Origin on every write (a non-browser client has no business here).
    if (remote && !isRead && !sameOrigin) throw new HttpError(403, "Forbidden origin");
    const route = `${req.method} ${url.pathname}`;
    let device: DeviceInfo | null = null;
    if (
      remote &&
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/health" &&
      route !== "POST /api/pair"
    ) {
      device = devices.authenticate(req.headers.cookie);
      if (!device) throw new HttpError(401, "This device isn't paired");
    }

    switch (route) {
      case "GET /api/health":
        return sendJson(res, 200, { ok: true, app: APP_NAME, version: options.version });

      case "GET /api/state":
        return sendJson(res, 200, {
          sessions: store.list(),
          tools: options.tools,
          decisions: decisions.list(),
        });

      case "GET /api/stream":
        return stream(req, res, url, device, remoteHost);

      case "GET /api/me":
        return sendJson(
          res,
          200,
          device
            ? { remote: true, device: { name: device.name, allowApprovals: device.allowApprovals } }
            : { remote: false },
        );

      case "POST /api/pair": {
        if (!remote) throw new HttpError(403, "Forbidden");
        const body = await readJsonBody(req);
        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const outcome = pairing.consume(record.code);
        if (outcome === "limited") throw new HttpError(429, "Too many attempts. Make a new code on your PC.");
        if (outcome === "invalid") throw new HttpError(403, "That pairing code is wrong or has expired");
        const created = await devices.create(cleanDeviceName(record.name) ?? "Phone");
        if (!created) throw new HttpError(409, "Too many paired devices. Revoke one first.");
        res.setHeader("set-cookie", deviceCookie(created.cookieValue));
        return sendJson(res, 200, { ok: true, device: created.device });
      }

      case "POST /api/devices/pair-code": {
        localOnly();
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        if (!config.remote?.enabled) throw new HttpError(409, "Turn on phone access first");
        return sendJson(res, 200, pairing.create());
      }

      case "GET /api/devices":
        localOnly();
        return sendJson(res, 200, { devices: devices.list() });

      case "GET /api/setup/remote":
        localOnly();
        return sendJson(res, 200, {
          enabled: config.remote?.enabled === true,
          hosts: config.remote?.hosts ?? [],
          port: port(),
        });

      case "POST /api/setup/remote/detect": {
        localOnly();
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        return sendJson(res, 200, { host: (await options.detectHost?.()) ?? null });
      }

      case "POST /api/setup/remote": {
        localOnly();
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        const body = await readJsonBody(req);
        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        if (typeof record.enabled !== "boolean" || !Array.isArray(record.hosts) || record.hosts.length > 5) {
          throw new HttpError(400, "Invalid remote settings");
        }
        const hosts = record.hosts.map(normalizeRemoteHost);
        if (hosts.some((h) => h === null))
          throw new HttpError(400, "Enter a host like mybox.tail1234.ts.net");
        const next: RemoteConfig = { enabled: record.enabled, hosts: [...new Set(hosts as string[])] };
        if (next.enabled && next.hosts.length === 0) throw new HttpError(400, "Add the host first");
        try {
          await options.saveRemote?.(next);
        } catch (error) {
          throw new HttpError(500, error instanceof Error ? error.message : String(error));
        }
        config.remote = next;
        // Streams already open were authorised by the old settings: close those no longer allowed.
        dropRemoteStreams((info) => !next.enabled || !next.hosts.includes(info.host));
        return sendJson(res, 200, { enabled: next.enabled, hosts: next.hosts, port: port() });
      }

      case "POST /api/events": {
        if (!hasToken()) throw new HttpError(401, "Missing or invalid token");
        const event = parseAgentEvent(await readJsonBody(req));
        if (!event) throw new HttpError(400, "Invalid event");
        store.apply(event);
        return sendJson(res, 202, { ok: true });
      }

      case "POST /api/decisions": {
        if (!hasToken()) throw new HttpError(401, "Missing or invalid token");
        return await registerDecision(await readJsonBody(req), res);
      }

      case "POST /api/presence": {
        // Same trust as the other dashboard writes: browsers can't forge Origin, local processes can (see AGENTS.md).
        // Remote requests got here with a valid device cookie and their own https Origin.
        if (!sameOrigin && !hasToken()) throw new HttpError(403, "Forbidden");
        const body = await readJsonBody(req);
        const { clientId, visible } = (typeof body === "object" && body !== null ? body : {}) as {
          clientId?: unknown;
          visible?: unknown;
        };
        if (typeof clientId !== "string" || !CLIENT_ID.test(clientId) || typeof visible !== "boolean") {
          throw new HttpError(400, "Invalid presence");
        }
        const viewer = viewers.get(clientId);
        if (!viewer) throw new HttpError(404, "Unknown client");
        // A device can only speak for its own tabs, and a loopback caller only for loopback tabs.
        if (viewer.deviceId !== device?.id) throw new HttpError(403, "Forbidden");
        viewer.visibleAt = visible ? Date.now() : null;
        checkViewers();
        return sendJson(res, 200, { ok: true });
      }

      case "POST /api/sessions/dismiss": {
        if (!sameOrigin && !hasToken()) throw new HttpError(403, "Forbidden");
        store.remove(await readSessionKey(req));
        return sendJson(res, 200, { ok: true });
      }

      case "POST /api/sessions/open": {
        // Launches local apps, so it gets the same origin/token check as any other write, and never works remotely.
        localOnly();
        if (!sameOrigin && !hasToken()) throw new HttpError(403, "Forbidden");
        const session = store.get(await readSessionKey(req));
        if (!session) throw new HttpError(404, "Unknown session");
        if (!options.openSession?.(session)) throw new HttpError(409, "This session can't be opened");
        return sendJson(res, 200, { ok: true });
      }

      case "GET /api/setup": {
        localOnly();
        if (!options.setup) throw new HttpError(404, "Not found");
        return sendJson(res, 200, await options.setup.status());
      }

      case "GET /api/setup/phone": {
        localOnly();
        if (!options.phone) throw new HttpError(404, "Not found");
        return sendJson(res, 200, publicPhone(options.phone.get()));
      }

      case "POST /api/setup/phone": {
        // Changes where notifications are sent: dashboard Origin on this computer only (see AGENTS.md).
        localOnly();
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        if (!options.phone) throw new HttpError(404, "Not found");
        const body = await readJsonBody(req);
        let next: PhoneConfig;
        try {
          next = applyPhoneUpdate(options.phone.get(), typeof body === "object" && body !== null ? body : {});
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        try {
          await options.phone.set(next);
        } catch (error) {
          throw new HttpError(500, error instanceof Error ? error.message : String(error));
        }
        return sendJson(res, 200, publicPhone(options.phone.get()));
      }

      case "POST /api/setup/phone/test": {
        localOnly();
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        if (!options.phone) throw new HttpError(404, "Not found");
        return sendJson(res, 200, await options.phone.sendTest());
      }

      case "POST /api/setup/connect": {
        localOnly();
        // Edits the user's agent configs: needs the dashboard's Origin. That stops other web pages (browsers can't
        // forge Origin) but not a local process, which can send any Origin header. See AGENTS.md.
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

      case "POST /api/setup/remote-actions": {
        localOnly();
        // Lets the dashboard approve commands and edits the user's agent config. Origin check only: stops web pages,
        // not local processes that set the header themselves (see AGENTS.md security notes).
        if (!sameOrigin) throw new HttpError(403, "Forbidden");
        if (!options.setup) throw new HttpError(404, "Not found");
        const body = await readJsonBody(req);
        const { enabled, dryRun } = (typeof body === "object" && body !== null ? body : {}) as {
          enabled?: unknown;
          dryRun?: unknown;
        };
        if (typeof enabled !== "boolean") throw new HttpError(400, "Missing enabled");
        try {
          return sendJson(res, 200, await options.setup.setRemoteActions(enabled, dryRun === true));
        } catch (error) {
          if (error instanceof UnknownToolError) throw new HttpError(400, error.message);
          throw new HttpError(500, error instanceof Error ? error.message : String(error));
        }
      }

      case "POST /api/shutdown": {
        // Only the CLI (which can read the token) may stop the server, not a web page.
        localOnly();
        if (origin !== undefined || !hasToken()) throw new HttpError(403, "Forbidden");
        sendJson(res, 200, { ok: true });
        options.onShutdown?.();
        return;
      }

      default: {
        const deviceRoute = DEVICE_PATH.exec(url.pathname);
        if (deviceRoute) {
          localOnly();
          const id = deviceRoute[1] ?? "";
          if (req.method !== "POST" && req.method !== "DELETE")
            throw new HttpError(405, "Method not allowed");
          if (!sameOrigin) throw new HttpError(403, "Forbidden");
          if (req.method === "DELETE") {
            if (!devices.get(id)) throw new HttpError(404, "Unknown device");
            // revoke() forgets the device synchronously and saves afterwards: cut its streams and presence before
            // waiting for the disk, so a slow or failing save never leaves it connected.
            const revoking = devices.revoke(id);
            dropRemoteStreams((info) => info.deviceId === id);
            try {
              await revoking;
            } catch {
              // The device stays revoked in memory and the save is retried on the next write.
              throw new HttpError(
                500,
                "The phone is revoked for now, but saving that failed, so it could come back after a restart. Press Revoke again to retry.",
              );
            }
            return sendJson(res, 200, { ok: true });
          }
          const body = await readJsonBody(req);
          const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
          const name = record.name === undefined ? undefined : cleanDeviceName(record.name);
          if (
            name === null ||
            (record.allowApprovals !== undefined && typeof record.allowApprovals !== "boolean")
          ) {
            throw new HttpError(400, "Invalid device settings");
          }
          const updated = await devices.update(id, {
            ...(name !== undefined ? { name } : {}),
            ...(typeof record.allowApprovals === "boolean" ? { allowApprovals: record.allowApprovals } : {}),
          });
          if (!updated) throw new HttpError(404, "Unknown device");
          // Whether this phone's visible tab holds prompts depends on its approval setting.
          checkViewers();
          return sendJson(res, 200, { device: updated });
        }
        const decisionRoute = DECISION_PATH.exec(url.pathname);
        if (decisionRoute) {
          const [, id = "", action] = decisionRoute;
          if (action === "wait" && req.method === "GET") {
            if (!hasToken()) throw new HttpError(401, "Missing or invalid token");
            return waitForDecision(id, url, res);
          }
          if (action === "resolve" && req.method === "POST") {
            // Approving runs commands. Requires the dashboard's Origin, which blocks web pages (browsers can't forge
            // it) but is not authentication: a local process can send the header too. A login cookie is planned.
            if (!sameOrigin) throw new HttpError(403, "Forbidden");
            // Approving runs commands on this PC, so a phone needs the per-device opt-in.
            if (remote && !device?.allowApprovals) throw new HttpError(403, "This device can't approve");
            return resolveDecision(id, await readJsonBody(req), res);
          }
          throw new HttpError(405, "Method not allowed");
        }
        if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        return serveStatic(options.staticDir, url.pathname, res);
      }
    }
  }

  async function registerDecision(body: unknown, res: ServerResponse): Promise<void> {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const { tool, sessionId, kind, toolName, preview } = record;
    if (typeof tool !== "string" || typeof sessionId !== "string" || typeof toolName !== "string") {
      throw new HttpError(400, "Invalid decision");
    }
    if (kind !== "permission" && kind !== "question" && kind !== "plan")
      throw new HttpError(400, "Invalid decision");
    if (!tool || tool.length > 64 || !sessionId || sessionId.length > 256 || !toolName) {
      throw new HttpError(400, "Invalid decision");
    }
    const questions = kind === "question" ? parseQuestions(record.questions) : undefined;
    if (kind === "question" && !questions) throw new HttpError(400, "Invalid questions");

    // Nothing to wait for: the caller falls back to Claude Code's own prompt straight away.
    if (config.remoteActions !== true) return sendJson(res, 200, { id: null, reason: "disabled" });
    if (!hasVisibleViewer()) return sendJson(res, 200, { id: null, reason: "no_viewer" });
    const key = sessionKey(tool, sessionId);
    if (!store.get(key)) return sendJson(res, 200, { id: null, reason: "unknown_session" });

    const created = decisions.create({
      sessionKey: key,
      kind,
      toolName: truncate(toolName, 100),
      preview: typeof preview === "string" ? preview : undefined,
      questions: questions ?? undefined,
    });
    if (created.id === null) return sendJson(res, 200, created);
    sendJson(res, 200, { id: created.id });
  }

  async function waitForDecision(id: string, url: URL, res: ServerResponse): Promise<void> {
    const asked = Number(url.searchParams.get("ms"));
    const ms = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), MAX_WAIT_MS) : MAX_WAIT_MS;
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const result = await decisions.wait(id, ms, controller.signal);
    if (res.writableEnded || res.destroyed) return;
    switch (result.type) {
      case "resolved":
        // Consumed only once the answer is really on its way out; otherwise the next poll still gets it.
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(result.resolution), () => decisions.consume(id));
        return;
      case "timeout":
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      case "gone":
        throw new HttpError(410, "This request is over");
      case "unknown":
        throw new HttpError(404, "Unknown request");
    }
  }

  async function resolveDecision(id: string, body: unknown, res: ServerResponse): Promise<void> {
    switch (decisions.resolve(id, body)) {
      case "ok":
        return sendJson(res, 200, { ok: true });
      case "invalid":
        throw new HttpError(400, "Invalid answer");
      case "answered":
        throw new HttpError(409, "Already answered");
      case "gone":
        throw new HttpError(410, "This request is over");
      case "unknown":
        throw new HttpError(404, "Unknown request");
    }
  }

  function stream(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    device: DeviceInfo | null,
    remoteHost: string | null,
  ): void {
    const clientId = url.searchParams.get("client") ?? "";
    // A client id belongs to whoever opened it first: a phone can't take over a local tab's id or vice versa.
    // Checked before anything is written, so a refused stream gets no data at all.
    const existing = CLIENT_ID.test(clientId) ? viewers.get(clientId) : undefined;
    if (existing && existing.deviceId !== device?.id) throw new HttpError(409, "That client id is in use");
    // No (valid) id: it still gets events, but never counts as someone looking.
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { sessions: store.list(), tools: options.tools, decisions: decisions.list() });
    if (CLIENT_ID.test(clientId)) {
      const viewer = existing ?? {
        streams: new Set<ServerResponse>(),
        visibleAt: null,
        ...(device ? { deviceId: device.id } : {}),
      };
      viewer.streams.add(res);
      viewers.set(clientId, viewer);
    }

    if (device && remoteHost) {
      deviceStreams.set(res, {
        deviceId: device.id,
        host: remoteHost,
        clientId: CLIENT_ID.test(clientId) ? clientId : null,
      });
    }
    const unsubscribe = store.subscribe((change: StoreChange) => {
      if (change.type === "upsert") send("upsert", change.session);
      else send("remove", { key: change.key });
    });
    const unsubscribeDecisions = decisions.subscribe((change) => {
      if (change.type === "add") send("decision", change.decision);
      else send("decision-remove", { id: change.id });
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      deviceStreams.delete(res);
      const viewer = viewers.get(clientId);
      if (viewer) {
        viewer.streams.delete(res);
        if (viewer.streams.size === 0) viewers.delete(clientId);
      }
      checkViewers();
      unsubscribe();
      unsubscribeDecisions();
    });
  }

  return server;
}
