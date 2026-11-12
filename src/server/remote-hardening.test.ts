import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, defaultToolSettings } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import { DecisionStore } from "./decisions.js";
import { DeviceStore, type DeviceWriter } from "./devices.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";
const HOST = "box.tail1234.ts.net";
const OTHER = "other.tail9.ts.net";

interface Harness {
  server: ReturnType<typeof createAppServer>;
  config: Config;
  devices: DeviceStore;
  port: number;
}

let h: Harness;
let dir: string;
let streams: { close: () => void }[];
let saveRemote: (remote: unknown) => Promise<void>;

async function boot(
  pairing?: { maxAttempts?: number; windowMs?: number },
  deviceWriter?: DeviceWriter,
): Promise<Harness> {
  const config: Config = {
    port: 0,
    token: TOKEN,
    notifications: false,
    remoteActions: true,
    remote: { enabled: true, hosts: [HOST] },
    tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
  };
  const devices = new DeviceStore(join(dir, "devices.json"), deviceWriter);
  const server = createAppServer({
    config,
    store: new SessionStore(),
    devices,
    decisions: new DecisionStore({ ttlMs: 60_000 }),
    tools: [],
    staticDir: "does-not-exist",
    version: "0.0.0-test",
    presence: { graceMs: 150 },
    ...(pairing ? { pairing } : {}),
    saveRemote: (remote) => saveRemote(remote),
    detectHost: async () => HOST,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, config, devices, port: (server.address() as AddressInfo).port };
}

async function shutdown(): Promise<void> {
  for (const stream of streams) stream.close();
  h.server.closeAllConnections();
  await new Promise((resolve) => h.server.close(resolve));
  // A background save must not still be writing into the folder that is about to be deleted.
  await h.devices.idle();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentwatch-hardening-"));
  streams = [];
  saveRemote = async () => {};
  h = await boot();
});

afterEach(async () => {
  await shutdown();
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
      {
        host: "127.0.0.1",
        port: h.port,
        method,
        path,
        headers: { host: `127.0.0.1:${h.port}`, ...options.headers },
      },
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

const local = () => ({ origin: `http://127.0.0.1:${h.port}` });
const phoneHeaders = (cookie?: string, origin: string | null = `https://${HOST}`, host = HOST) => ({
  host,
  ...(origin ? { origin } : {}),
  ...(cookie ? { cookie } : {}),
});

const code = async (): Promise<string> =>
  (JSON.parse((await send("POST", "/api/devices/pair-code", { headers: local() })).body) as { code: string })
    .code;

async function pair(name = "Pixel"): Promise<{ cookie: string; id: string }> {
  const res = await send("POST", "/api/pair", {
    headers: phoneHeaders(),
    body: { code: await code(), name },
  });
  expect(res.status).toBe(200);
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "";
  return {
    cookie: setCookie.split(";")[0] ?? "",
    id: (JSON.parse(res.body) as { device: { id: string } }).device.id,
  };
}

/** Opens a stream; `closed` resolves when the server ends or destroys it. */
function watchStream(headers: Record<string, string>, clientId: string) {
  let onClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const opened = new Promise<{ status: number; body: () => string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: h.port, path: `/api/stream?client=${clientId}`, headers });
    streams.push({ close: () => req.destroy() });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("close", onClosed);
      res.on("error", onClosed);
      resolve({ status: res.statusCode ?? 0, body: () => body });
    });
    req.on("error", (error) => {
      onClosed();
      reject(error);
    });
    req.end();
  });
  return { opened, closed };
}

const presence = (headers: Record<string, string>, clientId: string, visible = true) =>
  send("POST", "/api/presence", { headers, body: { clientId, visible } }).then((r) => r.status);

const register = async (): Promise<{ id: string | null; reason?: string }> =>
  JSON.parse(
    (
      await send("POST", "/api/decisions", {
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { tool: "claude-code", sessionId: "s1", kind: "permission", toolName: "Bash" },
      })
    ).body,
  );

const startSession = () =>
  send("POST", "/api/events", {
    headers: { authorization: `Bearer ${TOKEN}` },
    body: {
      tool: "claude-code",
      sessionId: "s1",
      cwd: "C:\\p",
      status: "working",
      timestamp: new Date().toISOString(),
    },
  });

describe("pairing limits", () => {
  const attempt = async (value: string) =>
    (await send("POST", "/api/pair", { headers: phoneHeaders(), body: { code: value, name: "a" } })).status;

  it("counts only failed attempts, so successful pairings never lock anyone out", async () => {
    await shutdown();
    h = await boot({ maxAttempts: 2 });
    for (let i = 0; i < 5; i++) expect(await attempt(await code())).toBe(200);
  });

  it("locks out after failures, then forgets them when the PC makes a new code", async () => {
    await shutdown();
    h = await boot({ maxAttempts: 2 });
    const first = await code();
    expect(await attempt("g1")).toBe(403);
    expect(await attempt("g2")).toBe(403);
    const limited = await send("POST", "/api/pair", {
      headers: phoneHeaders(),
      body: { code: first, name: "a" },
    });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatch(/new code on your PC/);
    expect(await attempt(await code())).toBe(200);
  });

  it("lets failures age out of the window", async () => {
    await shutdown();
    h = await boot({ maxAttempts: 1, windowMs: 80 });
    const c = await code();
    expect(await attempt("g1")).toBe(403);
    expect(await attempt(c)).toBe(429);
    await new Promise((r) => setTimeout(r, 150));
    expect(await attempt(c)).toBe(200);
  });
});

describe("stream and presence ownership", () => {
  it("refuses a presence update across the loopback/phone boundary", async () => {
    const { cookie } = await pair();
    expect((await watchStream({ host: `127.0.0.1:${h.port}` }, "client-local111").opened).status).toBe(200);
    expect((await watchStream(phoneHeaders(cookie, null), "client-phone111").opened).status).toBe(200);
    expect(await presence(phoneHeaders(cookie), "client-local111")).toBe(403);
    expect(await presence(local(), "client-phone111")).toBe(403);
    expect(await presence(local(), "client-local111")).toBe(200);
    expect(await presence(phoneHeaders(cookie), "client-phone111")).toBe(200);
  });

  it("answers 409 without any data when a stream asks for a client id someone else owns", async () => {
    const { cookie } = await pair();
    expect((await watchStream({ host: `127.0.0.1:${h.port}` }, "client-local222").opened).status).toBe(200);
    const conflict = await watchStream(phoneHeaders(cookie, null), "client-local222").opened;
    expect(conflict.status).toBe(409);
    await new Promise((r) => setTimeout(r, 50));
    expect(conflict.body()).not.toContain("snapshot");
    expect(conflict.body()).not.toContain("sessions");
  });
});

describe("switching remote access off", () => {
  it("closes open phone streams and drops their presence", async () => {
    const { cookie, id } = await pair();
    const allow = await send("POST", `/api/devices/${id}`, {
      headers: local(),
      body: { allowApprovals: true },
    });
    expect(allow.status).toBe(200);
    await startSession();
    const watch = watchStream(phoneHeaders(cookie, null), "client-ffff6666");
    expect((await watch.opened).status).toBe(200);
    expect(await presence(phoneHeaders(cookie), "client-ffff6666")).toBe(200);
    expect((await register()).id).toEqual(expect.any(String));

    const off = await send("POST", "/api/setup/remote", {
      headers: local(),
      body: { enabled: false, hosts: [HOST] },
    });
    expect(off.status).toBe(200);
    await watch.closed;
    // Nobody visible is left: the next prompt goes straight to the terminal.
    expect((await register()).reason).toBe("no_viewer");
  });

  it("closes only the streams of a host that was removed", async () => {
    h.config.remote = { enabled: true, hosts: [HOST, OTHER] };
    const { cookie } = await pair();
    const removed = watchStream(phoneHeaders(cookie, null), "client-gggg7777");
    const kept = watchStream(phoneHeaders(cookie, null, OTHER), "client-hhhh8888");
    expect((await removed.opened).status).toBe(200);
    expect((await kept.opened).status).toBe(200);
    const res = await send("POST", "/api/setup/remote", {
      headers: local(),
      body: { enabled: true, hosts: [OTHER] },
    });
    expect(res.status).toBe(200);
    await removed.closed;
    const state = await send("GET", "/api/state", { headers: phoneHeaders(cookie, null, OTHER) });
    expect(state.status).toBe(200);
    expect(await presence(phoneHeaders(cookie, `https://${OTHER}`, OTHER), "client-hhhh8888")).toBe(200);
  });

  it("reports a failed save and leaves the settings alone", async () => {
    saveRemote = async () => {
      throw new Error("The config file is missing");
    };
    const res = await send("POST", "/api/setup/remote", {
      headers: local(),
      body: { enabled: false, hosts: [] },
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatch(/config file is missing/);
    expect(h.config.remote).toEqual({ enabled: true, hosts: [HOST] });
  });
});

describe("revoking when the disk write fails", () => {
  it("cuts the device off, reports the error and saves on the next write", async () => {
    let failing = false;
    await shutdown();
    h = await boot(undefined, async (path, contents) => {
      if (failing) throw new Error("disk full");
      await writeFile(path, contents, "utf8");
    });
    const { cookie, id } = await pair();
    const watch = watchStream(phoneHeaders(cookie, null), "client-iiii9999");
    expect((await watch.opened).status).toBe(200);

    failing = true;
    const revoke = await send("DELETE", `/api/devices/${id}`, { headers: local() });
    expect(revoke.status).toBe(500);
    expect(revoke.body).toMatch(/revoked for now/);
    await watch.closed;
    expect(h.devices.unsaved).toBe(true);
    // Dead at once in memory, whatever the disk says.
    expect((await send("GET", "/api/state", { headers: phoneHeaders(cookie, null) })).status).toBe(401);
    expect((JSON.parse((await send("GET", "/api/devices")).body) as { devices: unknown[] }).devices).toEqual(
      [],
    );
    expect(await presence(local(), "client-iiii9999")).toBe(404);

    // The next write (here: pairing another phone) carries the revocation to disk.
    failing = false;
    const second = await pair("Second");
    await h.devices.idle();
    expect(h.devices.unsaved).toBe(false);
    const onDisk = JSON.parse(await readFile(join(dir, "devices.json"), "utf8")) as {
      devices: { id: string }[];
    };
    expect(onDisk.devices.map((d) => d.id)).toEqual([second.id]);
  });
});
