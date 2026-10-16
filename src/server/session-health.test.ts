import { describe, expect, it } from "vitest";
import { SessionStore, type StoreChange } from "../core/store.js";
import type { AgentEvent } from "../core/types.js";
import { createSessionHealth, EXPIRE_AFTER_MS, processIsAlive, STALL_AFTER_MS } from "./session-health.js";

const T0 = Date.parse("2026-10-16T12:00:00.000Z");

function setup(alive: Set<number> = new Set()) {
  const store = new SessionStore();
  const changes: StoreChange[] = [];
  store.subscribe((c) => changes.push(c));
  let clock = T0;
  const health = createSessionHealth({ store, isAlive: (pid) => alive.has(pid), now: () => clock });
  const apply = (sessionId: string, partial: Partial<AgentEvent>) =>
    store.apply({
      tool: "claude-code",
      sessionId,
      cwd: "C:\\projects\\demo",
      status: "working",
      timestamp: new Date(clock).toISOString(),
      ...partial,
    });
  return { store, health, changes, apply, advance: (ms: number) => (clock += ms) };
}

describe("session health", () => {
  it("removes sessions whose agent process is gone", () => {
    const { store, health, apply } = setup(new Set([100]));
    apply("alive", { pid: 100 });
    apply("dead", { pid: 200 });
    apply("no-pid", {});
    health.tick();
    expect(
      store
        .list()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["alive", "no-pid"]);
  });

  it("marks long-quiet working sessions as stalled, without counting it as activity", () => {
    const { store, health, apply, advance, changes } = setup();
    apply("s", { status: "working" });
    advance(STALL_AFTER_MS - 1000);
    health.tick();
    expect(store.get("claude-code:s")?.stalled).toBeUndefined();

    advance(2000);
    health.tick();
    const session = store.get("claude-code:s");
    expect(session?.stalled).toBe(true);
    expect(session?.updatedAt).toBe(new Date(T0).toISOString());
    const last = changes.at(-1);
    expect(last?.type === "upsert" && last.previousStatus).toBe("working"); // no status change → no notification

    apply("s", { status: "working" }); // any event clears it
    expect(store.get("claude-code:s")?.stalled).toBeUndefined();
  });

  it("clears finished sessions after an hour, but never ones that need you", () => {
    const { store, health, apply, advance } = setup();
    apply("done", { status: "done" });
    apply("idle", { status: "idle" });
    apply("waiting", { status: "needs_input" });
    advance(EXPIRE_AFTER_MS + 1000);
    health.tick();
    expect(store.list().map((s) => s.sessionId)).toEqual(["waiting"]);
  });
});

describe("status timing", () => {
  it("statusSince marks when the status started, not the last event", () => {
    const { store, apply, advance } = setup();
    apply("s", { status: "working" });
    advance(60_000);
    apply("s", { status: "working", message: "Bash" });
    expect(store.get("claude-code:s")?.statusSince).toBe(new Date(T0).toISOString());
    advance(60_000);
    apply("s", { status: "done" });
    expect(store.get("claude-code:s")?.statusSince).toBe(new Date(T0 + 120_000).toISOString());
  });
});

describe("processIsAlive", () => {
  it("knows this process exists and a nonsense pid doesn't", () => {
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(2 ** 30)).toBe(false);
  });
});
