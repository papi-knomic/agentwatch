import { describe, expect, it } from "vitest";
import { SessionStore } from "../core/store.js";
import type { AgentEvent } from "../core/types.js";
import { APPROVED_MESSAGE, createApprovalWatcher } from "./approval-watch.js";
import type { ChildProcessInfo } from "./process-list.js";

/** The last activity before the prompt (e.g. the previous tool call). */
const ACTIVITY_AT = Date.parse("2026-10-16T11:59:55.000Z");
/** When our "needs input" hook event arrived. */
const PROMPT_AT = Date.parse("2026-10-16T12:00:00.000Z");

function setup(listing: ChildProcessInfo[][] | ChildProcessInfo[], event: Partial<AgentEvent> = {}) {
  const store = new SessionStore();
  const base = { tool: "claude-code", sessionId: "s1", cwd: "C:\\projects\\demo", pid: 100, ...event };
  store.apply({
    ...base,
    status: "working",
    message: "Read",
    timestamp: new Date(ACTIVITY_AT).toISOString(),
  });
  store.apply({
    ...base,
    status: "needs_input",
    message: "Claude needs your permission to use Bash",
    timestamp: new Date(PROMPT_AT).toISOString(),
  });
  // One listing per tick; a flat array means "the same children every tick".
  const ticks = Array.isArray(listing[0])
    ? (listing as ChildProcessInfo[][])
    : [listing as ChildProcessInfo[]];
  const queried: number[][] = [];
  const watcher = createApprovalWatcher({
    store,
    listChildren: async (pids) => {
      queried.push(pids);
      return ticks[Math.min(queried.length - 1, ticks.length - 1)] ?? [];
    },
    now: () => PROMPT_AT + 30_000,
  });
  const twoTicks = async () => {
    await watcher.tick();
    await watcher.tick();
  };
  return { store, watcher, twoTicks, queried, status: () => store.get("claude-code:s1")?.status };
}

const child = (overrides: Partial<ChildProcessInfo>): ChildProcessInfo => ({
  pid: 200,
  parentPid: 100,
  startedAt: PROMPT_AT + 10_000,
  name: "cmd.exe",
  command: 'cmd.exe /d /s /c "npm test"',
  ...overrides,
});

describe("approval watcher", () => {
  it("moves a waiting session to working once the approved shell has been seen twice", async () => {
    const { store, watcher, status } = setup([child({})]);
    await watcher.tick();
    expect(status()).toBe("needs_input"); // one sighting isn't enough
    await watcher.tick();
    expect(status()).toBe("working");
    expect(store.get("claude-code:s1")?.message).toBe(APPROVED_MESSAGE);
  });

  it("catches a fast approval: the command started within a second of the prompt", async () => {
    const { twoTicks, status } = setup([child({ startedAt: PROMPT_AT + 300 })]);
    await twoTicks();
    expect(status()).toBe("working");
  });

  it("catches a late hook: our needs-input event arrived after the command had started", async () => {
    const { twoTicks, status } = setup([child({ startedAt: PROMPT_AT - 2000 })]);
    await twoTicks();
    expect(status()).toBe("working");
  });

  it("ignores shells that were running before the last activity (background tasks)", async () => {
    const { twoTicks, status } = setup([child({ startedAt: ACTIVITY_AT - 60_000 })]);
    await twoTicks();
    expect(status()).toBe("needs_input");
  });

  it("ignores a short-lived process that is gone by the next check (e.g. another tool's hook)", async () => {
    const { twoTicks, status } = setup([[child({ pid: 300 })], [], [child({ pid: 301 })]]);
    await twoTicks();
    expect(status()).toBe("needs_input");
  });

  it("never counts our own hook processes", async () => {
    const hook = child({ command: 'cmd.exe /c node "C:/x/cli.js" hook --tool claude-code' });
    const { twoTicks, status } = setup([hook]);
    await twoTicks();
    expect(status()).toBe("needs_input");
  });

  it("ignores non-shell children and other parents", async () => {
    const { twoTicks, status } = setup([child({ name: "git.exe" }), child({ pid: 201, parentPid: 999 })]);
    await twoTicks();
    expect(status()).toBe("needs_input");
  });

  it("does nothing, and lists nothing, when no session waits with a pid", async () => {
    const { twoTicks, queried } = setup([child({})], { pid: undefined });
    await twoTicks();
    expect(queried).toEqual([]);
  });

  it("survives a failing process listing, logging it once", async () => {
    const store = new SessionStore();
    store.apply({
      tool: "claude-code",
      sessionId: "s1",
      cwd: "/x",
      status: "needs_input",
      pid: 100,
      timestamp: new Date(PROMPT_AT).toISOString(),
    });
    const logs: string[] = [];
    const watcher = createApprovalWatcher({
      store,
      listChildren: async () => {
        throw new Error("boom");
      },
      log: (m) => logs.push(m),
    });
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("boom");
    expect(store.get("claude-code:s1")?.status).toBe("needs_input");
  });
});
