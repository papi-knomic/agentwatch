import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, type StoreChange } from "./store.js";
import type { AgentEvent } from "./types.js";

const event = (overrides: Partial<AgentEvent>): AgentEvent => ({
  tool: "claude-code",
  sessionId: "s1",
  cwd: "C:\\projects\\demo",
  status: "working",
  timestamp: "2026-10-16T12:00:00.000Z",
  ...overrides,
});

describe("SessionStore", () => {
  it("creates and updates a session, reporting the previous status", () => {
    const store = new SessionStore();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));

    store.apply(event({ status: "working" }));
    store.apply(event({ status: "done", timestamp: "2026-10-16T12:01:00.000Z" }));

    expect(changes.map((c) => (c.type === "upsert" ? [c.session.status, c.previousStatus] : c.type))).toEqual(
      [
        ["working", null],
        ["done", "working"],
      ],
    );
    expect(store.list()).toHaveLength(1);
    expect(store.get("claude-code:s1")?.startedAt).toBe("2026-10-16T12:00:00.000Z");
  });

  it("drops events older than the session's latest one", () => {
    const store = new SessionStore();
    store.apply(event({ status: "done", timestamp: "2026-10-16T12:01:00.000Z" }));
    expect(store.apply(event({ status: "working", timestamp: "2026-10-16T12:00:59.000Z" }))).toBeNull();
    expect(store.get("claude-code:s1")?.status).toBe("done");
  });

  it("never carries a message over to the next event", () => {
    const store = new SessionStore();
    store.apply(event({ status: "needs_input", message: "Permission for Bash" }));
    store.apply(event({ status: "working", timestamp: "2026-10-16T12:00:01.000Z" }));
    expect(store.get("claude-code:s1")?.message).toBeUndefined();
    store.apply(
      event({
        status: "working",
        message: "Running approved command",
        timestamp: "2026-10-16T12:00:02.000Z",
      }),
    );
    expect(store.get("claude-code:s1")?.message).toBe("Running approved command");
    store.apply(event({ status: "done", timestamp: "2026-10-16T12:00:03.000Z" }));
    expect(store.get("claude-code:s1")?.message).toBeUndefined();
  });

  it("keeps the first task title for the whole session", () => {
    const store = new SessionStore();
    store.apply(event({ status: "idle" }));
    store.apply(event({ title: "Fix login bug", timestamp: "2026-10-16T12:00:01.000Z" }));
    store.apply(event({ status: "done", timestamp: "2026-10-16T12:00:02.000Z" }));
    store.apply(event({ title: "Also update the docs", timestamp: "2026-10-16T12:00:03.000Z" }));
    expect(store.get("claude-code:s1")?.title).toBe("Fix login bug");
  });

  it("lets the tool's own session name replace a prompt title and stay current", () => {
    const store = new SessionStore();
    store.apply(event({ title: "can you look at the login thing", timestamp: "2026-10-16T12:00:01.000Z" }));
    store.apply(
      event({ title: "Fix login bug", titleSource: "tool", timestamp: "2026-10-16T12:00:02.000Z" }),
    );
    expect(store.get("claude-code:s1")).toMatchObject({ title: "Fix login bug", titleSource: "tool" });

    store.apply(event({ title: "another prompt", timestamp: "2026-10-16T12:00:03.000Z" }));
    store.apply(event({ status: "done", timestamp: "2026-10-16T12:00:04.000Z" }));
    expect(store.get("claude-code:s1")).toMatchObject({ title: "Fix login bug", titleSource: "tool" });

    store.apply(
      event({ title: "Plan: OAuth login", titleSource: "tool", timestamp: "2026-10-16T12:00:05.000Z" }),
    );
    expect(store.get("claude-code:s1")?.title).toBe("Plan: OAuth login");
  });

  it("removes the session when it ends", () => {
    const store = new SessionStore();
    store.apply(event({}));
    const change = store.apply(event({ status: "ended", timestamp: "2026-10-16T12:00:01.000Z" }));
    expect(change).toEqual({ type: "remove", key: "claude-code:s1" });
    expect(store.list()).toEqual([]);
  });

  it("ignores an end for a session it never saw", () => {
    expect(new SessionStore().apply(event({ status: "ended" }))).toBeNull();
  });

  it("prunes sessions that went quiet", () => {
    const store = new SessionStore();
    store.apply(event({ timestamp: "2026-10-15T00:00:00.000Z" }));
    store.apply(event({ sessionId: "s2", timestamp: "2026-10-16T11:00:00.000Z" }));
    store.pruneStale(new Date("2026-10-16T12:00:00.000Z"));
    expect(store.list().map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("saves and loads sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-store-"));
    try {
      const path = join(dir, "sessions.json");
      const store = new SessionStore();
      store.apply(event({ timestamp: new Date().toISOString() }));
      await store.save(path);
      const loaded = new SessionStore();
      await loaded.load(path);
      expect(loaded.list()).toEqual(store.list());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
