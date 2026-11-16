import { describe, expect, it, vi } from "vitest";
import { defaultPhoneConfig, type PhoneConfig } from "../core/phone.js";
import type { Session } from "../core/types.js";
import { buildHeaders, buildPhoneMessage, createPhoneNotifier, publish, publishUrl } from "./ntfy.js";

const TOPIC = "abcdefghijklmnop_-ABCDEF";
const phone = (over: Partial<PhoneConfig> = {}): PhoneConfig => ({
  ...defaultPhoneConfig(),
  enabled: true,
  topic: TOPIC,
  ...over,
});

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude-code:s1",
    tool: "claude-code",
    sessionId: "s1",
    cwd: "C:\\Users\\alice\\secret-project",
    status: "needs_input",
    title: "Fix the payroll bug",
    message: "Wants to run rm -rf",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statusSince: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildPhoneMessage", () => {
  it("is generic when details are off", () => {
    const m = buildPhoneMessage(session(), "needs_input", "Claude Code", { includeDetails: false });
    const text = JSON.stringify(m);
    expect(m.title).toBe("Claude Code");
    expect(m.body).toBe("Needs your input");
    for (const secret of ["alice", "secret-project", "payroll", "rm -rf", "C:"])
      expect(text).not.toContain(secret);
  });
  it("adds only the folder name, title and message when details are on", () => {
    const m = buildPhoneMessage(session(), "needs_input", "Claude Code", { includeDetails: true });
    expect(m.body).toBe("Needs your input\nsecret-project\nFix the payroll bug\nWants to run rm -rf");
    expect(m.body).not.toContain("alice");
    expect(m.body).not.toContain("C:");
  });
  it("uses high priority only for needs_input", () => {
    const d = { includeDetails: false };
    expect(buildPhoneMessage(session(), "needs_input", "x", d).priority).toBe("high");
    expect(buildPhoneMessage(session(), "done", "x", d).priority).toBe("default");
    expect(buildPhoneMessage(session(), "done", "x", d).body).toBe("Finished");
    expect(buildPhoneMessage(session(), "error", "x", d).body).toBe("Error");
  });
  it("links the dashboard only through an enabled remote host", () => {
    const d = { includeDetails: false };
    expect(buildPhoneMessage(session(), "done", "x", d).click).toBeUndefined();
    expect(
      buildPhoneMessage(session(), "done", "x", d, { enabled: false, hosts: ["a.ts.net"] }).click,
    ).toBeUndefined();
    expect(buildPhoneMessage(session(), "done", "x", d, { enabled: true, hosts: [] }).click).toBeUndefined();
    expect(
      buildPhoneMessage(session(), "done", "x", d, { enabled: true, hosts: ["pc.tail1.ts.net"] }).click,
    ).toBe("https://pc.tail1.ts.net/");
  });
});

describe("headers", () => {
  const msg = { title: "Claude Code", body: "b", priority: "high" as const, tags: ["bell"] };
  it("sets the documented ntfy headers", () => {
    expect(buildHeaders(msg, undefined)).toEqual({ Title: "Claude Code", Priority: "high", Tags: "bell" });
  });
  it("adds Authorization only with a token", () => {
    expect(buildHeaders(msg, undefined).Authorization).toBeUndefined();
    expect(buildHeaders(msg, "tk_x").Authorization).toBe("Bearer tk_x");
  });
  it("adds Click and a view action only with a click url", () => {
    const h = buildHeaders({ ...msg, click: "https://pc.ts.net/" }, undefined);
    expect(h.Click).toBe("https://pc.ts.net/");
    expect(h.Actions).toBe("view, Open dashboard, https://pc.ts.net/");
    expect(buildHeaders(msg, undefined).Actions).toBeUndefined();
  });
  it("encodes non-ASCII titles so fetch accepts them", () => {
    expect(buildHeaders({ ...msg, title: "Café" }, undefined).Title).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });
});

describe("publish", () => {
  const msg = { title: "T", body: "hello", priority: "default" as const, tags: [] };
  it("posts the body to server/topic", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
    expect(await publish(phone({ token: "tk" }), msg, fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(publishUrl(phone()));
    expect(url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("hello");
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer tk");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it("swallows network errors without leaking the topic or token", async () => {
    const fetchImpl = async () => {
      throw new Error(`failed https://ntfy.sh/${TOPIC} Bearer tk`);
    };
    const result = await publish(phone({ token: "tk" }), msg, fetchImpl);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOPIC);
    expect(JSON.stringify(result)).not.toContain("tk");
  });
  it("reports a timeout and an HTTP error", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect((await publish(phone(), msg, async () => Promise.reject(timeout))).error).toMatch(/in time/);
    expect((await publish(phone(), msg, async () => ({ ok: false, status: 429 }))).error).toMatch(/429/);
  });
});

describe("createPhoneNotifier", () => {
  function setup(config: PhoneConfig | null = phone()) {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
    const log = vi.fn();
    const notifier = createPhoneNotifier({
      getPhone: () => config ?? undefined,
      log,
      fetchImpl,
      now: () => clock,
    });
    return { notifier, fetchImpl, log, advance: (ms: number) => (clock += ms) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("sends nothing when disabled or unset", async () => {
    const off = setup(phone({ enabled: false }));
    off.notifier.notify(session(), "done", "Claude Code");
    const none = setup(null);
    none.notifier.notify(session(), "done", "Claude Code");
    await flush();
    expect(off.fetchImpl).not.toHaveBeenCalled();
    expect(none.fetchImpl).not.toHaveBeenCalled();
  });
  it("limits a session to one push per 10 seconds", async () => {
    const { notifier, fetchImpl, advance } = setup();
    notifier.notify(session(), "done", "C");
    await flush();
    notifier.notify(session(), "needs_input", "C");
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(10_001);
    notifier.notify(session(), "needs_input", "C");
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("allows only one request in flight per session", async () => {
    let release: () => void = () => undefined;
    const fetchImpl = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<{ ok: boolean; status: number }>((r) => {
          release = () => r({ ok: true, status: 200 });
        }),
    );
    let clock = 0;
    const notifier = createPhoneNotifier({
      getPhone: () => phone(),
      log: () => undefined,
      fetchImpl,
      now: () => clock,
    });
    notifier.notify(session(), "done", "C");
    clock += 20_000;
    notifier.notify(session(), "done", "C");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await flush();
    notifier.notify(session(), "done", "C");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("caps total pushes at 30 per minute", async () => {
    const { notifier, fetchImpl, advance } = setup();
    for (let i = 0; i < 40; i++) notifier.notify(session({ key: `t:${i}` }), "done", "C");
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    advance(60_001);
    notifier.notify(session({ key: "t:new" }), "done", "C");
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(31);
  });
  it("logs one line on failure without the topic, and never throws", async () => {
    const log = vi.fn();
    const notifier = createPhoneNotifier({
      getPhone: () => phone(),
      log,
      fetchImpl: async () => {
        throw new Error(TOPIC);
      },
    });
    expect(() => notifier.notify(session(), "done", "C")).not.toThrow();
    await flush();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).not.toContain(TOPIC);
  });
  it("sendTest reports the outcome and needs a topic", async () => {
    expect((await setup(phone({ topic: "" })).notifier.sendTest()).ok).toBe(false);
    const { notifier, fetchImpl } = setup();
    expect((await notifier.sendTest()).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
