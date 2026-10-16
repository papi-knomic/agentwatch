import { describe, expect, it } from "vitest";
import { SessionStore } from "../core/store.js";
import type { AgentEvent } from "../core/types.js";
import { APPROVED_MESSAGE, createApprovalWatcher } from "./approval-watch.js";
import type { ChildProcessInfo } from "./process-list.js";

const PROMPT_AT = Date.parse("2026-10-16T12:00:00.000Z");

function setup(children: ChildProcessInfo[], event: Partial<AgentEvent> = {}) {
  const store = new SessionStore();
  store.apply({
    tool: "claude-code",
    sessionId: "s1",
    cwd: "C:\\projects\\demo",
    status: "needs_input",
    message: "Claude needs your permission to use Bash",
    pid: 100,
    timestamp: new Date(PROMPT_AT).toISOString(),
    ...event,
  });
  const queried: number[][] = [];
  const watcher = createApprovalWatcher({
    store,
    listChildren: async (pids) => {
      queried.push(pids);
      return children;
    },
    now: () => PROMPT_AT + 30_000,
  });
  return { store, watcher, queried, status: () => store.get("claude-code:s1")?.status };
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
  it("moves a waiting session to working when a new shell starts under the agent", async () => {
    const { store, watcher, status } = setup([child({})]);
    await watcher.tick();
    expect(status()).toBe("working");
    expect(store.get("claude-code:s1")?.message).toBe(APPROVED_MESSAGE);
  });

  it("ignores children that were already running before the prompt", async () => {
    const { watcher, status } = setup([child({ startedAt: PROMPT_AT - 60_000 })]);
    await watcher.tick();
    expect(status()).toBe("needs_input");
  });

  it("ignores hook processes started with the prompt", async () => {
    const hook = child({ command: 'cmd.exe /c node "C:/x/cli.js" hook --tool claude-code' });
    const early = child({ startedAt: PROMPT_AT + 500 });
    const { watcher, status } = setup([hook, early]);
    await watcher.tick();
    expect(status()).toBe("needs_input");
  });

  it("ignores non-shell children and other parents", async () => {
    const { watcher, status } = setup([child({ name: "git.exe" }), child({ parentPid: 999 })]);
    await watcher.tick();
    expect(status()).toBe("needs_input");
  });

  it("does nothing, and lists nothing, when no session waits with a pid", async () => {
    const { watcher, queried } = setup([child({})], { pid: undefined });
    await watcher.tick();
    expect(queried).toEqual([]);
  });

  it("survives a failing process listing", async () => {
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
    expect(logs[0]).toContain("boom");
    expect(store.get("claude-code:s1")?.status).toBe("needs_input");
  });
});
