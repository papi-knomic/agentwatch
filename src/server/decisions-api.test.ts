import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, defaultToolSettings } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import { DecisionStore } from "./decisions.js";
import { createAppServer } from "./server.js";

const TOKEN = "test-token-0123456789abcdef";

let server: ReturnType<typeof createAppServer>;
let store: SessionStore;
let decisions: DecisionStore;
let config: Config;
let port: number;
let streams: { close: () => void }[];

beforeEach(async () => {
  store = new SessionStore();
  decisions = new DecisionStore({ ttlMs: 60_000, shortHoldMs: 300 });
  streams = [];
  config = {
    port: 0,
    token: TOKEN,
    notifications: false,
    remoteActions: true,
    tools: { "claude-code": defaultToolSettings("Claude Code", "#d97757", "default") },
  };
  server = createAppServer({
    config,
    store,
    decisions,
    tools: [{ id: "claude-code", label: "Claude Code", color: "#d97757" }],
    staticDir: "does-not-exist",
    version: "0.0.0-test",
    presence: { graceMs: 150, hiddenMs: 150 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const stream of streams) stream.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

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

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const own = () => ({ origin: `http://127.0.0.1:${port}` });

let clients = 0;

/**
 * Opens the dashboard's SSE stream like a browser would (with its client id) and collects what it receives. By
 * default it also reports the tab as visible, as the dashboard does on connect.
 */
async function openDashboard(visible = true): Promise<{
  events: string[];
  close: () => void;
  clientId: string;
  setVisible: (visible: boolean) => Promise<number>;
}> {
  const clientId = `test-client-${++clients}`;
  const handle = await new Promise<{ events: string[]; close: () => void }>((resolve, reject) => {
    const events: string[] = [];
    const req = request({
      host: "127.0.0.1",
      port,
      path: `/api/stream?client=${clientId}`,
      headers: { host: `127.0.0.1:${port}` },
    });
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const match of chunk.matchAll(/^event: (.+)$/gm)) events.push(match[1] ?? "");
        resolve(handle);
      });
    });
    req.on("error", () => {});
    req.end();
    const handle = { events, close: () => req.destroy() };
    streams.push(handle);
    setTimeout(() => reject(new Error("stream did not open")), 2000).unref();
  });
  const setVisible = async (value: boolean) =>
    (await send("POST", "/api/presence", { headers: own(), body: { clientId, visible: value } })).status;
  if (visible) expect(await setVisible(true)).toBe(200);
  return { ...handle, clientId, setVisible };
}

async function startSession(): Promise<void> {
  const res = await send("POST", "/api/events", {
    headers: auth,
    body: {
      tool: "claude-code",
      sessionId: "s1",
      cwd: "C:\\p",
      status: "working",
      timestamp: new Date().toISOString(),
    },
  });
  expect(res.status).toBe(202);
}

const permissionBody = {
  tool: "claude-code",
  sessionId: "s1",
  kind: "permission",
  toolName: "Bash",
  preview: "npm test",
};

const questionBody = {
  tool: "claude-code",
  sessionId: "s1",
  kind: "question",
  toolName: "AskUserQuestion",
  questions: [{ question: "Pick?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
};

async function register(body: unknown = permissionBody): Promise<string> {
  const res = await send("POST", "/api/decisions", { headers: auth, body });
  expect(res.status).toBe(200);
  const { id } = JSON.parse(res.body) as { id: string | null };
  expect(id).toEqual(expect.any(String));
  return id as string;
}

describe("who counts as a viewer", () => {
  it("rejects a foreign web page reading state or opening the stream, but not the CLI or the dashboard", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await send("GET", "/api/state", { headers: evil })).status).toBe(403);
    expect((await send("GET", "/api/stream?client=evil-client-1", { headers: evil })).status).toBe(403);
    expect((await send("GET", "/api/state")).status).toBe(200);
    expect((await send("GET", "/api/state", { headers: own() })).status).toBe(200);
    expect((await send("GET", "/api/health", { headers: evil })).status).toBe(200);
    await startSession();
    // The rejected stream above must not have counted as someone looking.
    const res = await send("POST", "/api/decisions", { headers: auth, body: permissionBody });
    expect(JSON.parse(res.body)).toEqual({ id: null, reason: "no_viewer" });
  });

  it("takes a decision from any connected tab, visible or not, and from none otherwise", async () => {
    await startSession();
    const post = async () =>
      JSON.parse((await send("POST", "/api/decisions", { headers: auth, body: permissionBody })).body);
    expect(await post()).toEqual({ id: null, reason: "no_viewer" });
    const background = await openDashboard(false);
    expect((await post()).id).toEqual(expect.any(String));
    background.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await post()).toEqual({ id: null, reason: "no_viewer" });
  });

  it("mode short: holds for the full lifetime with a visible tab, and only briefly with background tabs", async () => {
    config.remoteActionsBackgroundHold = "short";
    await startSession();
    const lifetime = (id: string) => {
      const found = decisions.list().find((d) => d.id === id);
      return Date.parse(found?.expiresAt ?? "") - Date.parse(found?.createdAt ?? "");
    };
    const background = await openDashboard(false);
    const short = await register();
    expect(lifetime(short)).toBe(300);
    // Over after the short hold: the hook then prints nothing and Claude Code shows its own prompt.
    const res = await send("GET", `/api/decisions/${short}/wait?ms=5000`, { headers: auth });
    expect(res.status).toBe(410);

    await background.setVisible(true);
    expect(lifetime(await register())).toBe(60_000);
  });

  it("mode short: extends a short hold when a tab becomes visible, and shortens a full one when it hides", async () => {
    config.remoteActionsBackgroundHold = "short";
    await startSession();
    const background = await openDashboard(false);
    const id = await register();
    await background.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(decisions.list().map((d) => d.id)).toEqual([id]);

    await background.setVisible(false);
    const res = await send("GET", `/api/decisions/${id}/wait?ms=5000`, { headers: auth });
    expect(res.status).toBe(410);
  });

  it("tells the dashboard when a short hold becomes a full one", async () => {
    config.remoteActionsBackgroundHold = "short";
    await startSession();
    const background = await openDashboard(false);
    await register();
    await background.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(background.events.filter((e) => e === "decision").length).toBeGreaterThanOrEqual(2);
  });

  it("does not count a stream without a client id, or a presence report for a stream that is gone", async () => {
    await startSession();
    await new Promise<void>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/stream", headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.end();
      streams.push({ close: () => req.destroy() });
    });
    const res = await send("POST", "/api/decisions", { headers: auth, body: permissionBody });
    expect(JSON.parse(res.body).id).toBeNull();

    const dashboard = await openDashboard();
    dashboard.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await dashboard.setVisible(true)).toBe(404);
  });

  it("validates presence reports and only takes them from the dashboard origin or the token", async () => {
    const dashboard = await openDashboard(false);
    const body = { clientId: dashboard.clientId, visible: true };
    const evil = { origin: "https://evil.example" };
    expect((await send("POST", "/api/presence", { body })).status).toBe(403);
    expect((await send("POST", "/api/presence", { headers: evil, body })).status).toBe(403);
    const bad = { ...body, visible: "yes" };
    expect((await send("POST", "/api/presence", { headers: own(), body: bad })).status).toBe(400);
    const shortId = { ...body, clientId: "x" };
    expect((await send("POST", "/api/presence", { headers: own(), body: shortId })).status).toBe(400);
    expect((await send("POST", "/api/presence", { headers: auth, body })).status).toBe(200);
  });

  it("cancels a pending decision after a short grace once no tab is connected, so the terminal prompt appears", async () => {
    await startSession();
    const dashboard = await openDashboard();
    const id = await register();
    const started = Date.now();
    const waiting = send("GET", `/api/decisions/${id}/wait?ms=5000`, { headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 50));
    dashboard.close();
    const res = await waiting;
    expect(res.status).toBe(410);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(decisions.list()).toEqual([]);
  });

  it("cancels pending decisions when the last tab closes, but not while another visible tab remains", async () => {
    await startSession();
    const first = await openDashboard();
    const second = await openDashboard();
    const id = await register();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(decisions.list()).toHaveLength(1);

    second.close();
    const res = await send("GET", `/api/decisions/${id}/wait?ms=5000`, { headers: auth });
    expect(res.status).toBe(410);
  });
});

describe("answers that nobody was listening for", () => {
  it("cancels a decision whose hook never starts waiting", async () => {
    decisions = new DecisionStore({ ttlMs: 60_000, orphanMs: 120 });
    await new Promise((resolve) => server.close(resolve));
    server = createAppServer({
      config,
      store,
      decisions,
      tools: [],
      staticDir: "does-not-exist",
      version: "0.0.0-test",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    await startSession();
    await openDashboard();
    await register();
    expect(decisions.list()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(decisions.list()).toEqual([]);
  });

  it("keeps an answer whose poll socket closed first, for the next poll", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    const abandoned = request({
      host: "127.0.0.1",
      port,
      path: `/api/decisions/${id}/wait?ms=5000`,
      headers: { host: `127.0.0.1:${port}`, ...auth },
    });
    abandoned.on("error", () => {});
    abandoned.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    abandoned.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await send("POST", `/api/decisions/${id}/resolve`, { headers: own(), body: { behavior: "allow" } });
    const retry = await send("GET", `/api/decisions/${id}/wait?ms=100`, { headers: auth });
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.body)).toEqual({ behavior: "allow" });
  });
});

describe("POST /api/decisions", () => {
  it("needs the token, and rejects foreign origins even with it", async () => {
    await startSession();
    await openDashboard();
    expect((await send("POST", "/api/decisions", { body: permissionBody })).status).toBe(401);
    const evil = { ...auth, origin: "https://evil.example" };
    expect((await send("POST", "/api/decisions", { headers: evil, body: permissionBody })).status).toBe(403);
    expect(decisions.list()).toEqual([]);
  });

  it("answers null (so the hook falls through) when nobody is watching, the feature is off, or the session is unknown", async () => {
    await startSession();
    const post = async () =>
      JSON.parse((await send("POST", "/api/decisions", { headers: auth, body: permissionBody })).body);
    expect(await post()).toEqual({ id: null, reason: "no_viewer" });

    await openDashboard();
    config.remoteActions = false;
    expect(await post()).toEqual({ id: null, reason: "disabled" });
    config.remoteActions = true;

    const unknown = await send("POST", "/api/decisions", {
      headers: auth,
      body: { ...permissionBody, sessionId: "other" },
    });
    expect(JSON.parse(unknown.body)).toEqual({ id: null, reason: "unknown_session" });
    expect(decisions.list()).toEqual([]);
  });

  it("stops counting a dashboard once it disconnects", async () => {
    await startSession();
    const dashboard = await openDashboard();
    await register();
    dashboard.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await send("POST", "/api/decisions", { headers: auth, body: permissionBody });
    expect(JSON.parse(res.body).id).toBeNull();
  });

  it("rejects malformed bodies", async () => {
    await startSession();
    await openDashboard();
    for (const body of [
      {},
      { ...permissionBody, kind: "other" },
      { ...permissionBody, toolName: 3 },
      { ...questionBody, questions: [] },
      { ...questionBody, questions: [{ question: "Q", options: [] }] },
    ]) {
      expect((await send("POST", "/api/decisions", { headers: auth, body })).status).toBe(400);
    }
  });

  it("pushes the pending decision to the dashboard and shows it in state, but never saves it with sessions", async () => {
    await startSession();
    const dashboard = await openDashboard();
    const id = await register();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dashboard.events).toEqual(expect.arrayContaining(["snapshot", "decision"]));
    const state = JSON.parse((await send("GET", "/api/state")).body);
    expect(state.decisions).toEqual([
      expect.objectContaining({ id, sessionKey: "claude-code:s1", kind: "permission", preview: "npm test" }),
    ]);
    expect(JSON.stringify(store.list())).not.toContain("npm test");
  });

  it("truncates previews on the server too", async () => {
    await startSession();
    await openDashboard();
    await register({ ...permissionBody, preview: "x".repeat(5000) });
    expect(decisions.list()[0]?.preview?.length).toBe(300);
  });

  it("caps pending decisions per session", async () => {
    await startSession();
    await openDashboard();
    for (let i = 0; i < 5; i++) await register();
    const res = await send("POST", "/api/decisions", { headers: auth, body: permissionBody });
    expect(JSON.parse(res.body)).toEqual({ id: null, reason: "session_cap" });
  });
});

describe("POST /api/decisions/:id/resolve", () => {
  it("only accepts the dashboard's own origin, never the token alone", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    const path = `/api/decisions/${id}/resolve`;
    const body = { behavior: "allow" };
    expect((await send("POST", path, { body })).status).toBe(403);
    expect((await send("POST", path, { headers: auth, body })).status).toBe(403);
    expect((await send("POST", path, { headers: { origin: "https://evil.example" }, body })).status).toBe(
      403,
    );
    expect(
      (await send("POST", path, { headers: { ...auth, origin: "https://evil.example" }, body })).status,
    ).toBe(403);
    expect(
      (await send("POST", path, { headers: { origin: own().origin, host: "evil.example" }, body })).status,
    ).toBe(403);
    expect(decisions.list()).toHaveLength(1);

    expect((await send("POST", path, { headers: own(), body })).status).toBe(200);
    expect(decisions.list()).toEqual([]);
  });

  it("is one-shot, validates the answer, and distinguishes unknown from over", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    const path = `/api/decisions/${id}/resolve`;
    expect((await send("POST", path, { headers: own(), body: { behavior: "sure" } })).status).toBe(400);
    expect((await send("POST", path, { headers: own(), body: { behavior: "deny" } })).status).toBe(200);
    expect((await send("POST", path, { headers: own(), body: { behavior: "allow" } })).status).toBe(409);
    // Fetching the answer consumes the id.
    const waited = await send("GET", `/api/decisions/${id}/wait?ms=100`, { headers: auth });
    expect(JSON.parse(waited.body)).toEqual({ behavior: "deny" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await send("POST", path, { headers: own(), body: { behavior: "allow" } })).status).toBe(410);
    expect(
      (await send("POST", "/api/decisions/nope/resolve", { headers: own(), body: { behavior: "allow" } }))
        .status,
    ).toBe(404);
  });

  it("registers a plan, and validates approve / keep-planning feedback", async () => {
    await startSession();
    await openDashboard();
    const plan = "## Plan\n1. Go";
    const id = await register({ ...permissionBody, kind: "plan", toolName: "ExitPlanMode", preview: plan });
    expect(decisions.list()[0]).toMatchObject({ kind: "plan", preview: plan });
    const path = `/api/decisions/${id}/resolve`;
    const tooLong = { behavior: "deny", message: "x".repeat(1001) };
    expect((await send("POST", path, { headers: own(), body: tooLong })).status).toBe(400);
    expect(
      (await send("POST", path, { headers: own(), body: { behavior: "deny", message: 7 } })).status,
    ).toBe(400);
    const keep = { behavior: "deny", message: "Add a README line" };
    expect((await send("POST", path, { headers: own(), body: keep })).status).toBe(200);
    const waited = await send("GET", `/api/decisions/${id}/wait?ms=100`, { headers: auth });
    expect(JSON.parse(waited.body)).toEqual(keep);
  });

  it("checks question answers against the stored options", async () => {
    await startSession();
    await openDashboard();
    const id = await register(questionBody);
    const path = `/api/decisions/${id}/resolve`;
    expect((await send("POST", path, { headers: own(), body: { answers: { "Pick?": "C" } } })).status).toBe(
      400,
    );
    expect((await send("POST", path, { headers: own(), body: { behavior: "allow" } })).status).toBe(400);
    expect((await send("POST", path, { headers: own(), body: { answers: { "Pick?": "B" } } })).status).toBe(
      200,
    );
    const waited = await send("GET", `/api/decisions/${id}/wait?ms=100`, { headers: auth });
    expect(JSON.parse(waited.body)).toEqual({ answers: { "Pick?": "B" } });
  });
});

describe("GET /api/decisions/:id/wait", () => {
  it("needs the token (a dashboard origin alone is not enough)", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`)).status).toBe(401);
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: own() })).status).toBe(401);
  });

  it("returns 204 on timeout and the answer when it arrives mid-wait", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: auth })).status).toBe(204);

    const waiting = send("GET", `/api/decisions/${id}/wait?ms=5000`, { headers: auth });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await send("POST", `/api/decisions/${id}/resolve`, { headers: own(), body: { behavior: "allow" } });
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ behavior: "allow" });
  });

  it("returns 410 once a concurrent decision is cancelled by newer activity (answered in the host)", async () => {
    await startSession();
    await openDashboard();
    const id = await register({ ...permissionBody, concurrent: true });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await send("POST", "/api/events", {
      headers: auth,
      body: {
        tool: "claude-code",
        sessionId: "s1",
        cwd: "C:\\p",
        status: "working",
        message: "Ran Bash",
        timestamp: new Date().toISOString(),
      },
    });
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: auth })).status).toBe(410);
    expect(decisions.list()).toEqual([]);
  });

  it("returns 410 when the session ends and 404 for ids it never issued", async () => {
    await startSession();
    await openDashboard();
    const id = await register();
    store.remove("claude-code:s1");
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: auth })).status).toBe(410);
    expect((await send("GET", "/api/decisions/nope/wait?ms=50", { headers: auth })).status).toBe(404);
  });

  it("returns 410 after the deadline", async () => {
    decisions = new DecisionStore({ ttlMs: 80 });
    await new Promise((resolve) => server.close(resolve));
    server = createAppServer({
      config,
      store,
      decisions,
      tools: [],
      staticDir: "does-not-exist",
      version: "0.0.0-test",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    await startSession();
    await openDashboard();
    const id = await register();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: auth })).status).toBe(410);
  });
});

describe("concurrent decisions (VS Code / Claude Desktop permission and plan prompts)", () => {
  const concurrentBody = { ...permissionBody, concurrent: true };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function restartWith(options: ConstructorParameters<typeof DecisionStore>[0]): Promise<void> {
    decisions = new DecisionStore(options);
    await new Promise((resolve) => server.close(resolve));
    server = createAppServer({
      config,
      store,
      decisions,
      tools: [],
      staticDir: "does-not-exist",
      version: "0.0.0-test",
      presence: { graceMs: 100 },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }

  it("registers with no dashboard open, with a long hold, and shows the card to a tab that opens later", async () => {
    await startSession();
    const id = await register(concurrentBody);
    const found = decisions.list().find((d) => d.id === id);
    expect(Date.parse(found?.expiresAt ?? "") - Date.parse(found?.createdAt ?? "")).toBe(540_000);
    // Not cancelled for lack of a viewer, even well past the no-viewer grace.
    await sleep(400);
    expect(decisions.list().map((d) => d.id)).toEqual([id]);
    const late = await openDashboard();
    expect(late.events).toContain("snapshot");
    expect(decisions.list()).toHaveLength(1);
  });

  it("is not shortened when tabs hide or close, and not cancelled when the last tab goes", async () => {
    await startSession();
    const dashboard = await openDashboard();
    const id = await register(concurrentBody);
    const before = decisions.list()[0]?.expiresAt;
    await dashboard.setVisible(false);
    await sleep(450); // longer than the 300 ms short hold used by blocking decisions in this suite
    dashboard.close();
    await sleep(450);
    expect(decisions.list().map((d) => d.id)).toEqual([id]);
    expect(decisions.list()[0]?.expiresAt).toBe(before);
  });

  it("is still cancelled when the same agent moves on, and can be answered from the dashboard", async () => {
    await startSession();
    await register(concurrentBody);
    await sleep(1600); // past the cancel grace for events right after the request
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
    expect(decisions.list()).toEqual([]);
    expect(decisions.debugLog().at(-1)?.end).toBe("cancelled_by_agent_event");

    const id = await register(concurrentBody);
    expect(
      (await send("POST", `/api/decisions/${id}/resolve`, { headers: own(), body: { behavior: "allow" } }))
        .status,
    ).toBe(200);
    expect(decisions.debugLog().at(-1)?.end).toBe("resolved_allow");
  });

  it("marks a concurrent decision in /api/state for the dashboard, and only that one", async () => {
    await startSession();
    // A normal decision is only held while a dashboard tab is visible; a concurrent one needs none.
    const dashboard = await openDashboard();
    const plain = await register(permissionBody);
    const shared = await register(concurrentBody);
    dashboard.close();
    const state = JSON.parse((await send("GET", "/api/state", { headers: own() })).body) as {
      decisions: Array<Record<string, unknown>>;
    };
    const byId = new Map(state.decisions.map((d) => [d.id, d]));
    expect(byId.get(shared)).toHaveProperty("concurrent", true);
    expect(byId.get(plain)).not.toHaveProperty("concurrent");
  });

  it("registers a question as concurrent when its adapter says the host shows its own (OpenCode), without a viewer", async () => {
    config.remoteActionsBackgroundHold = "short";
    await startSession();
    // Without the claim a question still needs a viewer.
    const none = await send("POST", "/api/decisions", { headers: auth, body: questionBody });
    expect(JSON.parse(none.body)).toEqual({ id: null, reason: "no_viewer" });

    const id = await register({ ...questionBody, concurrent: true });
    expect(decisions.list().find((d) => d.id === id)).toHaveProperty("concurrent", true);
    expect(decisions.debugLog().at(-1)).toMatchObject({ kind: "question", hostClass: "concurrent" });
  });

  it("leaves nothing stuck when decide is killed (its wait connection drops)", async () => {
    await restartWith({ orphanMs: 120, shortHoldMs: 300 });
    await startSession();
    const id = await register(concurrentBody);
    const poll = request({
      host: "127.0.0.1",
      port,
      path: `/api/decisions/${id}/wait?ms=25000`,
      headers: { host: `127.0.0.1:${port}`, ...auth },
    });
    poll.on("error", () => {});
    poll.end();
    await sleep(60);
    expect(decisions.list()).toHaveLength(1); // a waiter is attached: not orphaned
    await sleep(150);
    expect(decisions.list()).toHaveLength(1);
    poll.destroy(); // the host killed the hook
    await sleep(400);
    expect(decisions.list()).toEqual([]);
    expect(decisions.debugLog().at(-1)).toMatchObject({ outcome: "registered", end: "orphan" });
    expect((await send("GET", `/api/decisions/${id}/wait?ms=100`, { headers: auth })).status).toBe(410);
  });
});

describe("GET /api/debug/decisions", () => {
  it("lists attempts and outcomes without any preview, command, question or plan text", async () => {
    await startSession();
    const secret = "rm -rf SECRET-COMMAND";
    // No viewer yet.
    await send("POST", "/api/decisions", { headers: auth, body: { ...permissionBody, preview: secret } });
    await openDashboard();
    await register({ ...permissionBody, preview: secret, agentId: "a0dcb4961017438ab" });
    await register({
      ...questionBody,
      questions: [{ question: "SECRET-QUESTION?", multiSelect: false, options: [{ label: "A" }] }],
    });
    await send("POST", "/api/decisions", { headers: auth, body: { nonsense: true } });
    await send("POST", "/api/decisions", {
      headers: auth,
      body: { ...permissionBody, sessionId: "nope", preview: secret },
    });

    const res = await send("GET", "/api/debug/decisions");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("SECRET");
    expect(res.body).not.toContain("s1"); // session ids are hashed
    const { decisions: log } = JSON.parse(res.body) as { decisions: Record<string, unknown>[] };
    expect(log.map((r) => r.outcome)).toEqual([
      "no_viewer",
      "registered",
      "registered",
      "invalid",
      "unknown_session",
    ]);
    expect(log[1]).toMatchObject({
      tool: "claude-code",
      kind: "permission",
      toolName: "Bash",
      agentId: true,
      hostClass: "blocking",
    });
    expect(log[1]?.session).toMatch(/^[0-9a-f]{8}$/);
    expect(log[0]).not.toHaveProperty("preview");
  });

  it("keeps only the last 50", async () => {
    await startSession();
    for (let i = 0; i < 55; i++)
      await send("POST", "/api/decisions", { headers: auth, body: permissionBody });
    const { decisions: log } = JSON.parse((await send("GET", "/api/debug/decisions")).body);
    expect(log).toHaveLength(50);
  });

  it("is refused to foreign web pages and to remote hosts", async () => {
    expect(
      (await send("GET", "/api/debug/decisions", { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect((await send("GET", "/api/debug/decisions", { headers: own() })).status).toBe(200);
    // A host that isn't ours is blocked before the handler (DNS rebinding guard).
    expect((await send("GET", "/api/debug/decisions", { headers: { host: "evil.example" } })).status).toBe(
      403,
    );
  });
});

describe("background hold modes (blocking prompts)", () => {
  const lifetime = (id: string) => {
    const found = decisions.list().find((d) => d.id === id);
    return Date.parse(found?.expiresAt ?? "") - Date.parse(found?.createdAt ?? "");
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const post = async (body: unknown = permissionBody) =>
    JSON.parse((await send("POST", "/api/decisions", { headers: auth, body })).body) as {
      id: string | null;
      reason?: string;
    };

  it("full (default): a hidden-only tab gets the full hold, and hiding never shortens it", async () => {
    await startSession();
    const background = await openDashboard(false);
    const id = (await post()).id as string;
    expect(lifetime(id)).toBe(60_000);
    expect(decisions.list().find((d) => d.id === id)?.backgroundHold).toBe("full");

    const tab = await openDashboard(true);
    const second = (await post()).id as string;
    await tab.setVisible(false);
    await sleep(500);
    expect(decisions.list().map((d) => d.id)).toEqual([id, second]);
    expect(lifetime(second)).toBe(60_000);
    background.close();
  });

  it("full: no connected tab at all still cancels after the grace", async () => {
    await startSession();
    const background = await openDashboard(false);
    const id = (await post()).id as string;
    background.close();
    await sleep(500);
    expect(decisions.list()).toEqual([]);
    expect(decisions.debugLog().find((r) => r.outcome === "registered")?.end).toBe("no_viewer_cancel");
    expect((await post()).id).toBeNull();
    expect(id).toEqual(expect.any(String));
  });

  it("short: a hidden-only tab gets the short hold", async () => {
    config.remoteActionsBackgroundHold = "short";
    await startSession();
    await openDashboard(false);
    expect(lifetime((await post()).id as string)).toBe(300);
  });

  it("off: not registered with only hidden tabs, registered with a visible one", async () => {
    config.remoteActionsBackgroundHold = "off";
    await startSession();
    const tab = await openDashboard(false);
    expect(await post()).toEqual({ id: null, reason: "no_viewer" });
    await tab.setVisible(true);
    const id = (await post()).id as string;
    expect(lifetime(id)).toBe(60_000);
    // A concurrent prompt is unaffected by the setting.
    expect((await post({ ...permissionBody, concurrent: true })).id).toEqual(expect.any(String));
  });

  it("off: hiding the last visible tab cancels blocking decisions after the debounce, not concurrent ones", async () => {
    config.remoteActionsBackgroundHold = "off";
    await startSession();
    const tab = await openDashboard(true);
    const id = (await post()).id as string;
    const concurrent = (await post({ ...permissionBody, concurrent: true })).id as string;
    await tab.setVisible(false);
    expect(decisions.list().map((d) => d.id)).toEqual([id, concurrent]); // debounce: not yet
    await tab.setVisible(true); // a quick flip back keeps it
    await sleep(400);
    expect(decisions.list().map((d) => d.id)).toEqual([id, concurrent]);

    await tab.setVisible(false);
    await sleep(500);
    expect(decisions.list().map((d) => d.id)).toEqual([concurrent]);
    expect(decisions.debugLog().find((r) => r.outcome === "registered")?.end).toBe("hidden_cancel");
    expect((await send("GET", `/api/decisions/${id}/wait?ms=50`, { headers: auth })).status).toBe(410);
  });

  it("applies a changed setting without a restart", async () => {
    await startSession();
    const tab = await openDashboard(false);
    const id = (await post()).id as string; // full
    config.remoteActionsBackgroundHold = "short";
    await tab.setVisible(false); // triggers a check
    await sleep(30);
    expect(lifetime(id)).toBeLessThan(60_000);
    config.remoteActionsBackgroundHold = "full";
    await tab.setVisible(false);
    await sleep(30);
    expect(lifetime(id)).toBe(60_000);
  });

  it("a blocking decision survives events from any agent and its own approval-watch style flip", async () => {
    await startSession();
    await openDashboard(true);
    const id = (await post()).id as string;
    await sleep(1700); // past the cancel grace that used to matter
    for (const body of [
      { status: "working", message: "Ran Bash" },
      { status: "working", message: "Edit", agentId: "agentB" },
      { status: "working", message: "Running approved command" },
      { status: "needs_input", message: "Claude needs your permission" },
    ]) {
      await send("POST", "/api/events", {
        headers: auth,
        body: {
          tool: "claude-code",
          sessionId: "s1",
          cwd: "C:p",
          timestamp: new Date().toISOString(),
          ...body,
        },
      });
    }
    expect(decisions.list().map((d) => d.id)).toEqual([id]);
  });
});
