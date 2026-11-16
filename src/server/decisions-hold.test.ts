import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionStore } from "./decisions.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const make = () => new DecisionStore({ ttlMs: 100_000, shortHoldMs: 15_000, orphanMs: 10 * 60_000 });
const ask = (store: DecisionStore, hold: "full" | "short") =>
  store.create({ sessionKey: "claude-code:s1", kind: "permission", toolName: "Bash", hold }).id as string;

describe("short hold (only background tabs)", () => {
  it("is cancelled after 15 s, so the hook prints nothing and Claude Code shows its own prompt", async () => {
    const store = make();
    const id = ask(store, "short");
    const waiting = store.wait(id, 60_000);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(waiting).resolves.toEqual({ type: "gone" });
    expect(store.list()).toEqual([]);
  });

  it("gets the full lifetime (counted from its creation) once a tab is visible", async () => {
    const store = make();
    const changes: string[] = [];
    store.subscribe((c) => changes.push(c.type));
    const id = ask(store, "short");
    await vi.advanceTimersByTimeAsync(10_000);
    store.extendShortHolds();
    expect(changes).toEqual(["add", "update"]);
    expect(Date.parse(store.list()[0]?.expiresAt ?? "") - Date.parse(store.list()[0]?.createdAt ?? "")).toBe(
      100_000,
    );
    await vi.advanceTimersByTimeAsync(80_000);
    expect(store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(store.list()).toEqual([]);
    expect(store.resolve(id, { behavior: "allow" })).toBe("gone");
  });

  it("a full hold shrinks to a short one, counted from when the tabs went hidden", async () => {
    const store = make();
    ask(store, "full");
    await vi.advanceTimersByTimeAsync(30_000);
    store.shortenFullHolds();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.list()).toEqual([]);
  });

  it("never lengthens a hold that was nearly over anyway", async () => {
    const store = make();
    ask(store, "full");
    await vi.advanceTimersByTimeAsync(95_000);
    store.shortenFullHolds();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(store.list()).toEqual([]);
  });

  it("an answered decision is left alone", async () => {
    const store = make();
    const id = ask(store, "short");
    expect(store.resolve(id, { behavior: "allow" })).toBe("ok");
    store.extendShortHolds();
    store.shortenFullHolds();
    expect(store.list()).toEqual([]);
  });
});

describe("maxHoldMs and visibleOnly (Codex)", () => {
  it("expires at the adapter's cap, never beyond the default, and ignores the short-hold shrink", async () => {
    const store = make();
    store.create({
      sessionKey: "codex:s",
      kind: "permission",
      toolName: "shell",
      maxHoldMs: 30_000,
      visibleOnly: true,
    });
    store.create({ sessionKey: "claude-code:s", kind: "permission", toolName: "Bash", maxHoldMs: 999_000 });
    expect(store.hasVisibleOnly()).toBe(true);
    store.shortenFullHolds();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(store.list().map((d) => d.sessionKey)).toEqual(["codex:s"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.list()).toEqual([]);
  });

  it("cancelPending(onlyVisibleOnly) leaves Claude Code decisions alone", () => {
    const store = make();
    store.create({ sessionKey: "codex:s", kind: "permission", toolName: "shell", visibleOnly: true });
    store.create({ sessionKey: "claude-code:s", kind: "permission", toolName: "Bash" });
    store.cancelPending("hidden_cancel", true);
    expect(store.list().map((d) => d.sessionKey)).toEqual(["claude-code:s"]);
  });
});
