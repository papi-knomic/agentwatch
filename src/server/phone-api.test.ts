import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, defaultToolSettings, setPhoneConfig } from "../core/config.js";
import { defaultPhoneConfig, type PhoneConfig } from "../core/phone.js";
import { SessionStore } from "../core/store.js";
import { createNotificationDispatcher } from "./notifications.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";
let server: ReturnType<typeof createAppServer>;
let port: number;
let phone: PhoneConfig;
let home: string;
let sendTest: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-phone-api-"));
  await writeFile(join(home, "config.json"), JSON.stringify({ token: TOKEN, custom: "keep" }));
  phone = { ...defaultPhoneConfig(), token: "tk_secret_value" };
  sendTest = vi.fn(async () => ({ ok: true }));
  const config: Config = {
    port: 0,
    token: TOKEN,
    notifications: false,
    tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
  };
  server = createAppServer({
    config,
    store: new SessionStore(),
    tools: [],
    staticDir: "does-not-exist",
    version: "test",
    phone: {
      get: () => phone,
      set: async (next) => {
        if (!(await setPhoneConfig(next, { AGENTWATCH_HOME: home }))) throw new Error("config file missing");
        phone = next;
      },
      sendTest: () => sendTest(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

function send(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const own = () => ({ origin: `http://127.0.0.1:${port}` });

describe("phone setup endpoints", () => {
  it("rejects writes without the dashboard origin or with a foreign one", async () => {
    expect((await send("POST", "/api/setup/phone", {}, { enabled: true })).status).toBe(403);
    const foreign = { origin: "https://evil.example" };
    expect((await send("POST", "/api/setup/phone", foreign, { enabled: true })).status).toBe(403);
    expect((await send("POST", "/api/setup/phone/test")).status).toBe(403);
    expect((await send("POST", "/api/setup/phone/test", foreign)).status).toBe(403);
    expect(sendTest).not.toHaveBeenCalled();
    expect(phone.enabled).toBe(false);
  });

  it("refuses foreign pages reading the settings", async () => {
    expect((await send("GET", "/api/setup/phone", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("enables with a generated topic, saves only the phone key, and never returns the token", async () => {
    const res = await send("POST", "/api/setup/phone", own(), { enabled: true });
    expect(res.status).toBe(200);
    const view = JSON.parse(res.body);
    expect(view.enabled).toBe(true);
    expect(view.topic).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(view.tokenSet).toBe(true);
    expect(res.body).not.toContain("tk_secret_value");
    const get = await send("GET", "/api/setup/phone", own());
    expect(get.body).not.toContain("tk_secret_value");
    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(onDisk.custom).toBe("keep");
    expect(onDisk.token).toBe(TOKEN);
    expect(onDisk.phone.token).toBe("tk_secret_value");
    expect(onDisk.phone.enabled).toBe(true);
  });

  it("rejects an http server", async () => {
    const res = await send("POST", "/api/setup/phone", own(), { server: "http://example.com" });
    expect(res.status).toBe(400);
    expect(phone.server).toBe("https://ntfy.sh");
  });

  it("answers 500 and changes nothing when the config file is missing", async () => {
    await rm(join(home, "config.json"));
    const res = await send("POST", "/api/setup/phone", own(), { enabled: true });
    expect(res.status).toBe(500);
    expect(res.body).toMatch(/config file missing/);
    expect(phone.enabled).toBe(false);
  });

  it("sends a test push", async () => {
    const res = await send("POST", "/api/setup/phone/test", own());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(sendTest).toHaveBeenCalledOnce();
  });
});

describe("dispatcher fan-out", () => {
  function run(over: Partial<Config> = {}, toolOver: Partial<Config["tools"][string]> = {}) {
    const config: Config = {
      port: 1,
      token: "x".repeat(32),
      notifications: true,
      tools: { "claude-code": { ...defaultToolSettings("Claude Code", "#d97757", "default"), ...toolOver } },
      ...over,
    };
    const notifier = vi.fn(async () => {});
    const phoneNotifier = { notify: vi.fn(), sendTest: vi.fn() };
    const store = new SessionStore();
    store.subscribe(
      createNotificationDispatcher({
        config,
        notifier,
        phone: phoneNotifier,
        dashboardUrl: "http://x",
        log: () => {},
      }),
    );
    const apply = (status: "working" | "needs_input" | "done") =>
      store.apply({
        tool: "claude-code",
        sessionId: "s",
        cwd: "/p",
        status,
        timestamp: new Date().toISOString(),
      });
    return { apply, notifier, phoneNotifier };
  }

  it("pushes alongside the desktop notification, labelled with the tool", () => {
    const { apply, notifier, phoneNotifier } = run();
    apply("working");
    apply("needs_input");
    expect(notifier).toHaveBeenCalledOnce();
    expect(phoneNotifier.notify).toHaveBeenCalledOnce();
    expect(phoneNotifier.notify.mock.calls[0]?.[1]).toBe("needs_input");
    expect(phoneNotifier.notify.mock.calls[0]?.[2]).toBe("Claude Code");
  });
  it("follows the global mute switch and per-tool rules", () => {
    for (const r of [run({ notifications: false }), run({}, { enabled: false })]) {
      r.apply("working");
      r.apply("needs_input");
      expect(r.notifier).not.toHaveBeenCalled();
      expect(r.phoneNotifier.notify).not.toHaveBeenCalled();
    }
    const perStatus = run({}, { notifyOn: { needs_input: false, done: true, error: true } });
    perStatus.apply("working");
    perStatus.apply("needs_input");
    expect(perStatus.phoneNotifier.notify).not.toHaveBeenCalled();
  });
});
