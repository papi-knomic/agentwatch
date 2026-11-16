import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, defaultToolSettings, type RemoteConfig } from "../core/config.js";
import { defaultPhoneConfig, type PhoneConfig } from "../core/phone.js";
import { SessionStore } from "../core/store.js";
import { DeviceStore } from "./devices.js";
import type { ServeController } from "./serve.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";
const HOST = "box.tail1234.ts.net";
const TOPIC = "abcdefghijklmnop1234567890ABCDEF";

let server: ReturnType<typeof createAppServer>;
let port: number;
let dir: string;
let config: Config;
let phone: PhoneConfig;
let saved: RemoteConfig[];
let devices: DeviceStore;
let serve: { [K in keyof ServeController]: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentwatch-wizard-"));
  saved = [];
  phone = { ...defaultPhoneConfig(), token: "tk_secret_value" };
  config = {
    port: 0,
    token: TOKEN,
    notifications: false,
    remote: { enabled: true, hosts: [HOST] },
    tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
  };
  serve = {
    status: vi.fn(async () => ({ state: "off" })),
    on: vi.fn(async () => ({ state: "on", host: HOST, created: true })),
    off: vi.fn(async () => ({ state: "off", turnedOff: true })),
  };
  devices = new DeviceStore(join(dir, "devices.json"));
  server = createAppServer({
    config,
    store: new SessionStore(),
    devices,
    tools: [],
    staticDir: "does-not-exist",
    version: "test",
    saveRemote: async (remote) => void saved.push(remote),
    serve: serve as unknown as ServeController,
    phone: {
      get: () => phone,
      set: async (next) => {
        phone = next;
      },
      sendTest: async () => ({ ok: true }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
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
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const own = () => ({ origin: `http://127.0.0.1:${port}` });
const phoneHeaders = (cookie?: string) => ({
  host: HOST,
  origin: `https://${HOST}`,
  ...(cookie ? { cookie } : {}),
});

async function pair(): Promise<string> {
  const { code } = JSON.parse((await send("POST", "/api/devices/pair-code", own())).body) as {
    code: string;
  };
  const res = await send("POST", "/api/pair", phoneHeaders(), { code, name: "Pixel" });
  expect(res.status).toBe(200);
  return (([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0] ?? "";
}

describe("POST /api/setup/remote/serve", () => {
  it("turns on: records the host and that AgentWatch manages the mapping", async () => {
    config.remote = { enabled: false, hosts: [] };
    const res = await send("POST", "/api/setup/remote/serve", own(), { action: "on" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: "on", host: HOST });
    expect(saved.at(-1)).toEqual({ enabled: true, hosts: [HOST], serve: { managed: true, https: 443 } });
  });

  it("does not claim a mapping it found already there", async () => {
    config.remote = { enabled: false, hosts: [] };
    serve.on.mockResolvedValueOnce({ state: "on", host: HOST, created: false });
    await send("POST", "/api/setup/remote/serve", own(), { action: "on" });
    expect(saved.at(-1)).toEqual({ enabled: true, hosts: [HOST] });
  });

  it("changes nothing when Tailscale needs consent", async () => {
    config.remote = { enabled: false, hosts: [] };
    serve.on.mockResolvedValueOnce({
      state: "needs_consent",
      consentUrl: "https://login.tailscale.com/f/x",
    });
    const res = await send("POST", "/api/setup/remote/serve", own(), { action: "on" });
    expect(JSON.parse(res.body).consentUrl).toBe("https://login.tailscale.com/f/x");
    expect(saved).toHaveLength(0);
    expect(config.remote?.enabled).toBe(false);
  });

  it("turns off: passes the managed flag and disables remote", async () => {
    config.remote = { enabled: true, hosts: [HOST], serve: { managed: true, https: 443 } };
    const res = await send("POST", "/api/setup/remote/serve", own(), { action: "off" });
    expect(res.status).toBe(200);
    expect(serve.off).toHaveBeenCalledWith(expect.any(Number), true);
    expect(saved.at(-1)).toEqual({ enabled: false, hosts: [HOST] });
  });

  it("off for an unmanaged mapping passes managed=false", async () => {
    await send("POST", "/api/setup/remote/serve", own(), { action: "off" });
    expect(serve.off).toHaveBeenCalledWith(expect.any(Number), false);
  });

  it("needs the dashboard origin and a valid action", async () => {
    expect((await send("POST", "/api/setup/remote/serve", {}, { action: "on" })).status).toBe(403);
    const foreign = { origin: "https://evil.example" };
    expect((await send("POST", "/api/setup/remote/serve", foreign, { action: "on" })).status).toBe(403);
    expect((await send("POST", "/api/setup/remote/serve", own(), { action: "reset" })).status).toBe(400);
    expect(serve.on).not.toHaveBeenCalled();
  });

  it("is not available to a remote host, even a paired phone", async () => {
    const cookie = await pair();
    const post = await send("POST", "/api/setup/remote/serve", phoneHeaders(cookie), { action: "on" });
    expect(post.status).toBe(403);
    expect((await send("GET", "/api/setup/remote/serve", phoneHeaders(cookie))).status).toBe(403);
    expect((await send("POST", "/api/setup/remote/serve", phoneHeaders(), { action: "on" })).status).toBe(
      401,
    );
    expect(serve.on).not.toHaveBeenCalled();
  });
});

describe("GET /api/me/ntfy", () => {
  const enable = () => {
    phone = { ...phone, enabled: true, topic: TOPIC };
  };

  it("needs a paired device when called through the proxy", async () => {
    enable();
    expect((await send("GET", "/api/me/ntfy", phoneHeaders())).status).toBe(401);
  });

  it("refuses a foreign origin", async () => {
    enable();
    const cookie = await pair();
    const res = await send("GET", "/api/me/ntfy", {
      ...phoneHeaders(cookie),
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("gives a paired phone the links and never the access token", async () => {
    enable();
    const cookie = await pair();
    const res = await send("GET", "/api/me/ntfy", phoneHeaders(cookie));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      enabled: true,
      link: `ntfy://ntfy.sh/${TOPIC}`,
      web: `https://ntfy.sh/${TOPIC}`,
    });
    expect(res.body).not.toContain("tk_secret_value");
  });

  it("says enabled:false when phone notifications are off, without the topic", async () => {
    phone = { ...phone, topic: TOPIC };
    const cookie = await pair();
    const res = await send("GET", "/api/me/ntfy", phoneHeaders(cookie));
    expect(JSON.parse(res.body)).toEqual({ enabled: false });
  });

  it("keeps the topic out of /api/state", async () => {
    enable();
    expect((await send("GET", "/api/state")).body).not.toContain(TOPIC);
  });
});
