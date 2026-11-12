import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, defaultToolSettings, normalizeRemoteHost, parseConfig } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import { DecisionStore } from "./decisions.js";
import { DeviceStore, type DeviceWriter } from "./devices.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";
const HOST = "box.tail1234.ts.net";

let server: ReturnType<typeof createAppServer>;
let store: SessionStore;
let config: Config;
let port: number;
let dir: string;
let streams: { close: () => void }[];
let saved: unknown[];
let devices: DeviceStore;

async function boot(
  pairing?: { codeTtlMs?: number; maxAttempts?: number },
  deviceWriter?: DeviceWriter,
): Promise<void> {
  store = new SessionStore();
  streams = [];
  saved = [];
  config = {
    port: 0,
    token: TOKEN,
    notifications: false,
    remoteActions: true,
    remote: { enabled: true, hosts: [HOST] },
    tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
  };
  devices = new DeviceStore(join(dir, "devices.json"), deviceWriter);
  server = createAppServer({
    config,
    store,
    devices,
    decisions: new DecisionStore({ ttlMs: 60_000 }),
    tools: [{ id: "claude-code", label: "Claude Code", color: "#d97757" }],
    staticDir: "does-not-exist",
    version: "0.0.0-test",
    presence: { graceMs: 150 },
    ...(pairing ? { pairing } : {}),
    saveRemote: async (remote) => void saved.push(remote),
    detectHost: async () => HOST,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentwatch-remote-"));
  await boot();
});

afterEach(async () => {
  for (const stream of streams) stream.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // A background save (lastSeenAt) must not still be writing into the folder that is about to be deleted.
  await devices.idle();
  await rm(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const local = () => ({ origin: `http://127.0.0.1:${port}` });
const phoneHeaders = (cookie?: string, origin: string | null = `https://${HOST}`) => ({
  host: HOST,
  ...(origin ? { origin } : {}),
  ...(cookie ? { cookie } : {}),
});

const code = async (): Promise<string> =>
  (JSON.parse((await send("POST", "/api/devices/pair-code", { headers: local() })).body) as { code: string })
    .code;

/** Pairs a phone through the real flow and returns its cookie header value. */
async function pair(name = "Pixel"): Promise<{ cookie: string; id: string }> {
  const res = await send("POST", "/api/pair", {
    headers: phoneHeaders(),
    body: { code: await code(), name },
  });
  expect(res.status).toBe(200);
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  return { cookie, id: (JSON.parse(res.body) as { device: { id: string } }).device.id };
}

async function approvals(id: string, allowApprovals: boolean): Promise<void> {
  const res = await send("POST", `/api/devices/${id}`, { headers: local(), body: { allowApprovals } });
  expect(res.status).toBe(200);
}

function openStream(headers: Record<string, string>, clientId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/stream?client=${clientId}`, headers });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      if (res.statusCode === 200) streams.push({ close: () => req.destroy() });
      else res.resume();
    });
    req.on("error", reject);
    req.end();
  });
}

describe("remote hosts", () => {
  it("rejects a remote Host while remote mode is off, exactly like any foreign host", async () => {
    config.remote = { enabled: false, hosts: [HOST] };
    expect((await send("GET", "/api/health", { headers: { host: HOST } })).status).toBe(403);
    expect((await send("GET", "/api/state", { headers: { host: HOST } })).status).toBe(403);
  });

  it("rejects other hosts when enabled, and accepts the host with :443 in any case", async () => {
    expect((await send("GET", "/api/health", { headers: { host: "evil.example.com" } })).status).toBe(403);
    expect((await send("GET", "/api/health", { headers: { host: `${HOST}:8080` } })).status).toBe(403);
    expect((await send("GET", "/api/health", { headers: { host: `${HOST}:443` } })).status).toBe(200);
    expect((await send("GET", "/api/health", { headers: { host: HOST.toUpperCase() } })).status).toBe(200);
  });

  it("leaves loopback behaviour unchanged", async () => {
    expect((await send("GET", "/api/state")).status).toBe(200);
    expect((await send("GET", "/api/me")).body).toBe(JSON.stringify({ remote: false }));
    expect((await send("GET", "/api/state", { headers: { origin: `https://${HOST}` } })).status).toBe(403);
    const event = {
      tool: "claude-code",
      sessionId: "s1",
      cwd: "C:\\p",
      status: "working",
      timestamp: new Date().toISOString(),
    };
    const post = await send("POST", "/api/events", {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: event,
    });
    expect(post.status).toBe(202);
  });

  it("validates hostnames", () => {
    expect(normalizeRemoteHost(" Box.Tail1234.TS.net ")).toBe(HOST);
    for (const bad of [
      "",
      "localhost",
      "127.0.0.1",
      "a b.example.com",
      "https://x.example.com",
      "x.com:443",
      "a..b.com",
    ]) {
      expect(normalizeRemoteHost(bad)).toBeNull();
    }
    expect(normalizeRemoteHost(`${"a".repeat(64)}.example.com`)).toBeNull();
  });

  it("defaults to disabled and drops invalid hosts when parsing config", () => {
    const defaults = { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") };
    expect(parseConfig({ token: TOKEN }, defaults)?.remote).toEqual({ enabled: false, hosts: [] });
    expect(
      parseConfig(
        { token: TOKEN, remote: { enabled: true, hosts: ["Ok.example.com", "bad host"] } },
        defaults,
      )?.remote,
    ).toEqual({ enabled: true, hosts: ["ok.example.com"] });
    // Enabled without any usable host is off.
    expect(
      parseConfig({ token: TOKEN, remote: { enabled: true, hosts: [] } }, defaults)?.remote?.enabled,
    ).toBe(false);
  });
});

describe("authentication of remote requests", () => {
  it("answers 401 without a cookie on state, stream and presence", async () => {
    expect((await send("GET", "/api/state", { headers: phoneHeaders(undefined, null) })).status).toBe(401);
    expect(await openStream(phoneHeaders(undefined, null), "client-aaaa1111")).toBe(401);
    const presence = await send("POST", "/api/presence", {
      headers: phoneHeaders(),
      body: { clientId: "client-aaaa1111", visible: true },
    });
    expect(presence.status).toBe(401);
    expect((await send("GET", "/api/me", { headers: phoneHeaders(undefined, null) })).status).toBe(401);
  });

  it("serves the health check and static files without a cookie", async () => {
    expect((await send("GET", "/api/health", { headers: phoneHeaders(undefined, null) })).status).toBe(200);
    // No dashboard build in tests, so the static handler answers 404 (not 401/403).
    expect((await send("GET", "/", { headers: phoneHeaders(undefined, null) })).status).not.toBe(401);
  });

  it("answers 401 for a forged, malformed or revoked cookie", async () => {
    const { cookie, id } = await pair();
    expect((await send("GET", "/api/state", { headers: phoneHeaders(cookie, null) })).status).toBe(200);
    const [name, value = ""] = cookie.split("=");
    const [, secret = ""] = value.split(".");
    for (const bad of [
      `${name}=${id}.${"A".repeat(43)}`,
      `${name}=nope.${secret}`,
      `${name}=${id}`,
      `${name}=${secret}`,
      "__Host-aw_device=",
    ]) {
      expect((await send("GET", "/api/state", { headers: phoneHeaders(bad, null) })).status).toBe(401);
    }
    expect((await send("DELETE", `/api/devices/${id}`, { headers: local() })).status).toBe(200);
    expect((await send("GET", "/api/state", { headers: phoneHeaders(cookie, null) })).status).toBe(401);
  });

  it("cuts a revoked device's open stream", async () => {
    const { cookie, id } = await pair();
    const closed = new Promise<void>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/api/stream?client=client-bbbb2222",
        headers: phoneHeaders(cookie, null),
      });
      req.on("response", (res) => {
        res.on("data", () => {});
        res.on("close", () => resolve());
        res.on("error", () => resolve());
      });
      req.on("error", () => resolve());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    await send("DELETE", `/api/devices/${id}`, { headers: local() });
    await closed;
  });

  it("reports the device on /api/me", async () => {
    const { cookie } = await pair("My phone");
    const me = JSON.parse((await send("GET", "/api/me", { headers: phoneHeaders(cookie, null) })).body);
    expect(me).toEqual({ remote: true, device: { name: "My phone", allowApprovals: false } });
  });
});

describe("pairing", () => {
  it("sets a hardened cookie and stores only a hash", async () => {
    const res = await send("POST", "/api/pair", {
      headers: phoneHeaders(),
      body: { code: await code(), name: "x".repeat(100) },
    });
    expect(res.status).toBe(200);
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "";
    expect(setCookie).toMatch(/^__Host-aw_device=[\w-]+\.[\w-]{43};/);
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${180 * 86400}`]) {
      expect(setCookie).toContain(part);
    }
    const secret = (setCookie.split(";")[0] ?? "").split(".")[1] ?? "";
    const file = await readFile(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(secret);
    expect(file).toMatch(/"secretHash": "[0-9a-f]{64}"/);
    expect(JSON.parse(res.body).device.name).toHaveLength(40);
    // The dashboard's device list never carries the hash either.
    expect((await send("GET", "/api/devices")).body).not.toContain("secretHash");
  });

  it("accepts a code only once", async () => {
    const c = await code();
    const body = { code: c, name: "a" };
    expect((await send("POST", "/api/pair", { headers: phoneHeaders(), body })).status).toBe(200);
    expect((await send("POST", "/api/pair", { headers: phoneHeaders(), body })).status).toBe(403);
  });

  it("rejects wrong, missing and non-string codes", async () => {
    await code();
    for (const bad of ["wrong", "", undefined, 5, { a: 1 }]) {
      const res = await send("POST", "/api/pair", {
        headers: phoneHeaders(),
        body: { code: bad, name: "a" },
      });
      expect(res.status).toBe(403);
    }
  });

  it("expires codes", async () => {
    await new Promise((resolve) => server.close(resolve));
    await boot({ codeTtlMs: 40 });
    const c = await code();
    await new Promise((r) => setTimeout(r, 80));
    expect(
      (await send("POST", "/api/pair", { headers: phoneHeaders(), body: { code: c, name: "a" } })).status,
    ).toBe(403);
  });

  it("keeps at most three codes outstanding", async () => {
    const [a, b, c, d] = [await code(), await code(), await code(), await code()];
    const attempt = async (value: string) =>
      (await send("POST", "/api/pair", { headers: phoneHeaders(), body: { code: value, name: "a" } })).status;
    expect(await attempt(a)).toBe(403);
    expect(await attempt(b)).toBe(200);
    expect(await attempt(c)).toBe(200);
    expect(await attempt(d)).toBe(200);
  });

  it("locks out after too many attempts, even for a valid code", async () => {
    await new Promise((resolve) => server.close(resolve));
    await boot({ maxAttempts: 3 });
    const c = await code();
    const attempt = async (value: string) =>
      (await send("POST", "/api/pair", { headers: phoneHeaders(), body: { code: value, name: "a" } })).status;
    expect(await attempt("g1")).toBe(403);
    expect(await attempt("g2")).toBe(403);
    expect(await attempt("g3")).toBe(403);
    expect(await attempt(c)).toBe(429);
  });

  it("rejects a pairing request with a wrong or missing Origin", async () => {
    const c = await code();
    for (const origin of ["https://evil.example.com", `http://${HOST}`, null]) {
      const res = await send("POST", "/api/pair", {
        headers: phoneHeaders(undefined, origin),
        body: { code: c },
      });
      expect(res.status).toBe(403);
    }
    // The code was not burnt by those.
    expect((await send("POST", "/api/pair", { headers: phoneHeaders(), body: { code: c } })).status).toBe(
      200,
    );
  });

  it("is not available on loopback", async () => {
    const res = await send("POST", "/api/pair", {
      headers: local(),
      body: { code: await code(), name: "a" },
    });
    expect(res.status).toBe(403);
  });

  it("offers pair codes only to the loopback dashboard and only when enabled", async () => {
    const { cookie } = await pair();
    expect((await send("POST", "/api/devices/pair-code", { headers: phoneHeaders(cookie) })).status).toBe(
      403,
    );
    expect((await send("POST", "/api/devices/pair-code")).status).toBe(403); // no Origin
    expect(
      (await send("POST", "/api/devices/pair-code", { headers: { origin: "https://evil.example.com" } }))
        .status,
    ).toBe(403);
    config.remote = { enabled: false, hosts: [HOST] };
    expect((await send("POST", "/api/devices/pair-code", { headers: local() })).status).toBe(409);
  });
});

describe("remote writes", () => {
  it("rejects foreign or missing Origin even with a valid cookie", async () => {
    const { cookie } = await pair();
    const body = { key: "x" };
    for (const origin of ["https://evil.example.com", `http://${HOST}`, `http://127.0.0.1:${port}`, null]) {
      const res = await send("POST", "/api/sessions/dismiss", {
        headers: phoneHeaders(cookie, origin),
        body,
      });
      expect(res.status).toBe(403);
    }
    expect(
      (await send("POST", "/api/sessions/dismiss", { headers: phoneHeaders(cookie), body })).status,
    ).toBe(200);
  });

  it("lets a paired phone dismiss sessions and report presence for its own stream", async () => {
    const { cookie } = await pair();
    expect(await openStream(phoneHeaders(cookie, null), "client-cccc3333")).toBe(200);
    const presence = (clientId: string) =>
      send("POST", "/api/presence", { headers: phoneHeaders(cookie), body: { clientId, visible: true } });
    expect((await presence("client-cccc3333")).status).toBe(200);
    expect((await presence("client-unknown1")).status).toBe(404);
  });

  it("never lets the token work through a remote host", async () => {
    const { cookie } = await pair();
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const event = {
      tool: "claude-code",
      sessionId: "s",
      cwd: "C:\\p",
      status: "working",
      timestamp: "2026-01-01T00:00:00Z",
    };
    const attempts: [string, string, unknown][] = [
      ["POST", "/api/shutdown", {}],
      ["POST", "/api/events", event],
      [
        "POST",
        "/api/decisions",
        { tool: "claude-code", sessionId: "s", kind: "permission", toolName: "Bash" },
      ],
      ["GET", "/api/decisions/abcdefgh/wait?ms=1", undefined],
      ["POST", "/api/sessions/dismiss", { key: "x" }],
    ];
    for (const [method, path, body] of attempts) {
      for (const extra of [{}, { cookie }]) {
        // Token plus the phone's Origin: still refused. Without a cookie it is a plain 401.
        const res = await send(method, path, {
          headers: {
            ...phoneHeaders(undefined, method === "GET" ? null : `https://${HOST}`),
            ...extra,
            ...bearer,
          },
          body,
        });
        const withCookie = "cookie" in extra;
        if (path === "/api/sessions/dismiss" && withCookie) continue; // the cookie, not the token, authorises this
        expect([401, 403], `${method} ${path} ${JSON.stringify(Object.keys(extra))}`).toContain(res.status);
      }
    }
    expect(store.list()).toHaveLength(0);
  });

  it("keeps device management, setup and open-session loopback only", async () => {
    const { cookie, id } = await pair();
    const h = phoneHeaders(cookie);
    const hRead = phoneHeaders(cookie, null);
    expect((await send("GET", "/api/devices", { headers: hRead })).status).toBe(403);
    expect(
      (await send("POST", `/api/devices/${id}`, { headers: h, body: { allowApprovals: true } })).status,
    ).toBe(403);
    expect((await send("DELETE", `/api/devices/${id}`, { headers: h })).status).toBe(403);
    expect((await send("GET", "/api/setup", { headers: hRead })).status).toBe(403);
    expect((await send("GET", "/api/setup/remote", { headers: hRead })).status).toBe(403);
    expect(
      (await send("POST", "/api/setup/remote", { headers: h, body: { enabled: false, hosts: [] } })).status,
    ).toBe(403);
    expect((await send("POST", "/api/setup/remote/detect", { headers: h })).status).toBe(403);
    expect((await send("POST", "/api/setup/connect", { headers: h, body: { tool: "all" } })).status).toBe(
      403,
    );
    expect(
      (await send("POST", "/api/setup/remote-actions", { headers: h, body: { enabled: false } })).status,
    ).toBe(403);
    expect((await send("POST", "/api/sessions/open", { headers: h, body: { key: "x" } })).status).toBe(403);
    // Still paired afterwards.
    expect(
      (JSON.parse((await send("GET", "/api/devices")).body) as { devices: unknown[] }).devices,
    ).toHaveLength(1);
  });
});

describe("approvals from a phone", () => {
  async function pendingDecision(): Promise<string> {
    const auth = { authorization: `Bearer ${TOKEN}` };
    await send("POST", "/api/events", {
      headers: auth,
      body: {
        tool: "claude-code",
        sessionId: "s1",
        cwd: "C:\\p",
        status: "working",
        timestamp: new Date().toISOString(),
      },
    });
    const res = await send("POST", "/api/decisions", {
      headers: auth,
      body: {
        tool: "claude-code",
        sessionId: "s1",
        kind: "permission",
        toolName: "Bash",
        preview: "npm test",
      },
    });
    return (JSON.parse(res.body) as { id: string }).id;
  }

  it("needs the per-device opt-in to resolve a prompt", async () => {
    const { cookie, id } = await pair();
    // A local tab keeps the prompt alive.
    const tab = "client-dddd4444";
    expect(await openStream({ host: `127.0.0.1:${port}` }, tab)).toBe(200);
    await send("POST", "/api/presence", { headers: local(), body: { clientId: tab, visible: true } });
    const decisionId = await pendingDecision();
    expect(decisionId).toEqual(expect.any(String));
    const resolve = () =>
      send("POST", `/api/decisions/${decisionId}/resolve`, {
        headers: phoneHeaders(cookie),
        body: { behavior: "allow" },
      });
    expect((await resolve()).status).toBe(403);
    await approvals(id, true);
    expect((await resolve()).status).toBe(200);
  });

  it("refuses a resolve with no cookie or a foreign Origin", async () => {
    const decisionId = "abcdefgh";
    const path = `/api/decisions/${decisionId}/resolve`;
    expect((await send("POST", path, { headers: phoneHeaders(), body: { behavior: "allow" } })).status).toBe(
      401,
    );
    const { cookie, id } = await pair();
    await approvals(id, true);
    const res = await send("POST", path, {
      headers: phoneHeaders(cookie, "https://evil.example.com"),
      body: { behavior: "allow" },
    });
    expect(res.status).toBe(403);
  });

  it("holds prompts for a visible phone only when it may approve", async () => {
    const { cookie, id } = await pair();
    const clientId = "client-eeee5555";
    expect(await openStream(phoneHeaders(cookie, null), clientId)).toBe(200);
    const visible = () =>
      send("POST", "/api/presence", { headers: phoneHeaders(cookie), body: { clientId, visible: true } });
    expect((await visible()).status).toBe(200);
    const register = async () =>
      JSON.parse(
        (
          await send("POST", "/api/decisions", {
            headers: { authorization: `Bearer ${TOKEN}` },
            body: { tool: "claude-code", sessionId: "s1", kind: "permission", toolName: "Bash" },
          })
        ).body,
      ) as { id: string | null; reason?: string };
    await send("POST", "/api/events", {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        tool: "claude-code",
        sessionId: "s1",
        cwd: "C:\\p",
        status: "working",
        timestamp: new Date().toISOString(),
      },
    });
    expect((await register()).reason).toBe("no_viewer");
    await approvals(id, true);
    expect((await register()).id).toEqual(expect.any(String));
  });
});

describe("remote settings", () => {
  it("saves hosts, normalises them and persists only remote", async () => {
    const ok = await send("POST", "/api/setup/remote", {
      headers: local(),
      body: { enabled: true, hosts: ["Other.Tail9.ts.net"] },
    });
    expect(ok.status).toBe(200);
    expect(saved).toEqual([{ enabled: true, hosts: ["other.tail9.ts.net"] }]);
    expect(config.remote).toEqual({ enabled: true, hosts: ["other.tail9.ts.net"] });
    // The old host no longer matches.
    expect((await send("GET", "/api/health", { headers: { host: HOST } })).status).toBe(403);
  });

  it("rejects invalid hosts and enabling without one", async () => {
    for (const body of [
      { enabled: true, hosts: ["127.0.0.1"] },
      { enabled: true, hosts: [] },
      { enabled: "yes", hosts: [] },
      { enabled: true, hosts: "x.example.com" },
    ]) {
      expect((await send("POST", "/api/setup/remote", { headers: local(), body })).status).toBe(400);
    }
    expect((await send("POST", "/api/setup/remote", { body: { enabled: false, hosts: [] } })).status).toBe(
      403,
    );
  });

  it("detects the Tailscale host through the injected detector", async () => {
    const res = await send("POST", "/api/setup/remote/detect", { headers: local() });
    expect(JSON.parse(res.body)).toEqual({ host: HOST });
  });
});
