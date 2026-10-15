import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultToolSettings } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import type { Session } from "../core/types.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";

let server: ReturnType<typeof createAppServer>;
let store: SessionStore;
let port: number;
let opened: Session[];

beforeEach(async () => {
  store = new SessionStore();
  opened = [];
  server = createAppServer({
    config: {
      port: 0,
      token: TOKEN,
      notifications: false,
      tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
    },
    store,
    tools: [{ id: "claude-code", label: "Claude Code", color: "#d97757" }],
    staticDir: "does-not-exist",
    version: "0.0.0-test",
    openSession: (session) => {
      if (session.host !== "VS Code") return false;
      opened.push(session);
      return true;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** node:http rather than fetch, so tests can set Host and Origin freely. */
function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const event = {
  tool: "claude-code",
  sessionId: "s1",
  cwd: "C:\\projects\\demo",
  status: "needs_input",
  message: "Claude needs your permission to use Bash",
  timestamp: "2026-10-16T12:00:00.000Z",
};
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("app server", () => {
  it("reports health", async () => {
    const res = await send("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, version: "0.0.0-test" });
  });

  it("accepts an event with the token and exposes it in state", async () => {
    expect((await send("POST", "/api/events", { headers: auth, body: event })).status).toBe(202);
    const state = JSON.parse((await send("GET", "/api/state")).body);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ status: "needs_input", cwd: event.cwd });
  });

  it("rejects events without a valid token", async () => {
    expect((await send("POST", "/api/events", { body: event })).status).toBe(401);
    const wrong = { authorization: "Bearer nope" };
    expect((await send("POST", "/api/events", { headers: wrong, body: event })).status).toBe(401);
    expect(store.list()).toEqual([]);
  });

  it("rejects malformed events", async () => {
    const res = await send("POST", "/api/events", { headers: auth, body: { ...event, status: "bogus" } });
    expect(res.status).toBe(400);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await send("GET", "/api/state", { headers: { host: `evil.example:${port}` } });
    expect(res.status).toBe(403);
  });

  it("rejects writes from other origins, even with the token", async () => {
    const headers = { ...auth, origin: "https://evil.example" };
    expect((await send("POST", "/api/events", { headers, body: event })).status).toBe(403);
  });

  it("lets the dashboard's own origin dismiss a session, but not other origins", async () => {
    await send("POST", "/api/events", { headers: auth, body: event });
    const evil = await send("POST", "/api/sessions/dismiss", {
      headers: { origin: "https://evil.example" },
      body: { key: "claude-code:s1" },
    });
    expect(evil.status).toBe(403);
    const noOrigin = await send("POST", "/api/sessions/dismiss", { body: { key: "claude-code:s1" } });
    expect(noOrigin.status).toBe(403);
    expect(store.list()).toHaveLength(1);

    const own = await send("POST", "/api/sessions/dismiss", {
      headers: { origin: `http://127.0.0.1:${port}` },
      body: { key: "claude-code:s1" },
    });
    expect(own.status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it("opens a session for the dashboard's own origin only", async () => {
    await send("POST", "/api/events", { headers: auth, body: { ...event, host: "VS Code" } });
    const body = { key: "claude-code:s1" };
    const evil = await send("POST", "/api/sessions/open", {
      headers: { origin: "https://evil.example" },
      body,
    });
    expect(evil.status).toBe(403);
    expect((await send("POST", "/api/sessions/open", { body })).status).toBe(403);
    expect(opened).toEqual([]);

    const own = { origin: `http://127.0.0.1:${port}` };
    expect((await send("POST", "/api/sessions/open", { headers: own, body })).status).toBe(200);
    expect(opened.map((s) => s.key)).toEqual(["claude-code:s1"]);
    const unknown = await send("POST", "/api/sessions/open", { headers: own, body: { key: "nope" } });
    expect(unknown.status).toBe(404);
  });

  it("refuses to open sessions that have nowhere to go", async () => {
    await send("POST", "/api/events", { headers: auth, body: { ...event, host: "Windows Terminal" } });
    const res = await send("POST", "/api/sessions/open", {
      headers: { origin: `http://127.0.0.1:${port}` },
      body: { key: "claude-code:s1" },
    });
    expect(res.status).toBe(409);
  });

  it("serves a placeholder page when the dashboard is not built", async () => {
    const res = await send("GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("npm run build");
  });

  it("does not serve files outside the static root", async () => {
    const res = await send("GET", "/..%2f..%2fpackage.json");
    expect(res.status).toBe(403);
  });
});
