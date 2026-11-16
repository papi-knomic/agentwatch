import { describe, expect, it } from "vitest";
import { DecisionStore } from "../server/decisions.js";
import { SessionStore } from "./store.js";
import { type AgentEvent, parseAgentEvent, UNATTRIBUTED_AGENT_ID } from "./types.js";

const KEY = "claude-code:s1";
const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const event = (seconds: number, overrides: Partial<AgentEvent>): AgentEvent => ({
  tool: "claude-code",
  sessionId: "s1",
  cwd: "C:\\projects\\demo",
  status: "working",
  timestamp: at(seconds),
  ...overrides,
});

const waits = (seconds: number, agentId: string | undefined, message = "needs permission") =>
  event(seconds, { status: "needs_input", message, ...(agentId ? { agentId } : {}) });

describe("pending input per agent", () => {
  it("stays needs_input while A waits: B's activity does not clear it, A's own does", () => {
    const store = new SessionStore();
    store.apply(event(0, { status: "working" }));
    store.apply(waits(1, "agentA", "A needs permission to use Write"));
    store.apply(event(2, { agentId: "agentB", message: "Bash" }));
    expect(store.get(KEY)).toMatchObject({
      status: "needs_input",
      message: "A needs permission to use Write",
      statusSince: at(1),
    });
    // The main agent's own tool call finishing (e.g. PostToolUse for the Agent tool) isn't A's answer either.
    store.apply(event(3, { message: "Agent" }));
    expect(store.get(KEY)?.status).toBe("needs_input");

    store.apply(event(4, { agentId: "agentA", message: "Write" }));
    expect(store.get(KEY)).toMatchObject({ status: "working", message: "Write" });
  });

  it("goes back to working only when every waiting agent has moved on", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA", "A asks"));
    store.apply(waits(2, "agentB", "B asks"));
    expect(store.get(KEY)?.message).toBe("B asks");
    store.apply(event(3, { agentId: "agentA", message: "Write" }));
    expect(store.get(KEY)).toMatchObject({ status: "needs_input", message: "B asks" });
    store.apply(event(4, { agentId: "agentB", message: "Edit" }));
    expect(store.get(KEY)?.status).toBe("working");
  });

  it("a subagent finishing clears only that subagent, and never marks the session done", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA"));
    store.apply(event(2, { agentId: "agentB", status: "done" }));
    expect(store.get(KEY)?.status).toBe("needs_input");
    store.apply(event(3, { agentId: "agentA", status: "done" }));
    expect(store.get(KEY)?.status).toBe("working");

    // A finished session stays finished when a background subagent reports its end.
    store.apply(event(4, { status: "done" }));
    store.apply(event(5, { agentId: "agentC", status: "done" }));
    expect(store.get(KEY)?.status).toBe("done");
  });

  it("a main-agent turn end or a new prompt clears every agent", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA"));
    store.apply(waits(2, undefined));
    store.apply(event(3, { status: "done" }));
    expect(store.get(KEY)?.status).toBe("done");

    store.apply(waits(4, "agentA"));
    store.apply(event(5, { status: "working", inputPending: false }));
    expect(store.get(KEY)?.status).toBe("working");

    store.apply(waits(6, "agentA"));
    store.apply(event(7, { status: "error", message: "rate_limit" }));
    expect(store.get(KEY)?.status).toBe("error");
  });

  it("an unattributed wait (a Notification) is ended by anyone's activity, like before", () => {
    const store = new SessionStore();
    store.apply(waits(1, UNATTRIBUTED_AGENT_ID, "Claude needs your permission to use Bash"));
    expect(store.get(KEY)?.status).toBe("needs_input");
    store.apply(event(2, { agentId: "agentB", message: "Bash" }));
    expect(store.get(KEY)?.status).toBe("working");
  });

  it("takes the Notification for a prompt the PermissionRequest hook already reported as the same prompt", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA", "A needs permission to use Write"));
    const ignored = store.apply(waits(2, UNATTRIBUTED_AGENT_ID, "Claude needs your permission to use Write"));
    expect(ignored).toBeNull();
    expect(store.get(KEY)?.message).toBe("A needs permission to use Write");
    // B's activity must not end A's wait (it would if the Notification had been kept as an unattributed one).
    store.apply(event(3, { agentId: "agentB", message: "Bash" }));
    expect(store.get(KEY)?.status).toBe("needs_input");

    // The other order: the Notification landed first and the attributed event replaces it.
    const other = new SessionStore();
    other.apply(waits(1, UNATTRIBUTED_AGENT_ID, "Claude needs your permission to use Write"));
    other.apply(waits(2, "agentA", "A needs permission to use Write"));
    other.apply(event(3, { agentId: "agentB", message: "Bash" }));
    expect(other.get(KEY)?.status).toBe("needs_input");
    other.apply(event(4, { agentId: "agentA", message: "Write" }));
    expect(other.get(KEY)?.status).toBe("working");

    // A later, separate prompt (more than a few seconds on) is not a duplicate.
    const later = new SessionStore();
    later.apply(waits(1, "agentA"));
    later.apply(event(2, { agentId: "agentA" }));
    expect(later.apply(waits(30, UNATTRIBUTED_AGENT_ID))).not.toBeNull();
    expect(later.get(KEY)?.status).toBe("needs_input");
  });

  it("an async question (inputPending) still survives other agents' activity", () => {
    const store = new SessionStore();
    store.apply(event(1, { status: "needs_input", inputPending: true, message: "Question" }));
    store.apply(event(2, { agentId: "agentB", message: "Bash" }));
    expect(store.get(KEY)).toMatchObject({ status: "needs_input", message: "Question" });
  });

  it("forgets who was waiting when the session ends", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA"));
    store.apply(event(2, { status: "ended" }));
    store.apply(event(3, { agentId: "agentB" }));
    expect(store.get(KEY)?.status).toBe("working");
  });

  it("never puts the agent id in the session itself (and so not in the session file)", () => {
    const store = new SessionStore();
    store.apply(waits(1, "agentA"));
    expect(JSON.stringify(store.get(KEY))).not.toContain("agentA");
  });
});

describe("active subagents", () => {
  it("counts subagents seen recently and not stopped", () => {
    const store = new SessionStore();
    store.apply(event(1, { agentId: "agentA" }));
    store.apply(event(2, { agentId: "agentB" }));
    expect(store.activeSubagents(KEY, T0 + 3000)).toBe(2);
    store.apply(event(4, { agentId: "agentA", status: "done" }));
    expect(store.activeSubagents(KEY, T0 + 5000)).toBe(1);
    // Not heard from for a long time: assumed gone.
    expect(store.activeSubagents(KEY, T0 + 30 * 60_000)).toBe(0);
    store.remove(KEY);
    expect(store.activeSubagents(KEY, T0 + 5000)).toBe(0);
  });
});

describe("agent ids from untrusted input", () => {
  const base = { tool: "claude-code", sessionId: "s1", cwd: "C:\\p", status: "working", timestamp: at(0) };
  it("accepts a plain id and drops anything else", () => {
    expect(parseAgentEvent({ ...base, agentId: "a0dcb4961017438ab" })?.agentId).toBe("a0dcb4961017438ab");
    for (const bad of ["", "has space", "a/b", "x".repeat(65), 5, null, ["a"]]) {
      expect(parseAgentEvent({ ...base, agentId: bad })?.agentId).toBeUndefined();
    }
  });
});

describe("concurrent decisions follow the agent that asked", () => {
  function setup() {
    let clock = T0;
    const sessions = new SessionStore();
    const decisions = new DecisionStore({ now: () => clock, orphanMs: 10 * 60_000 });
    sessions.subscribe((change) => decisions.handleSessionChange(change));
    const ask = (seconds: number, agentId?: string) => {
      clock = T0 + seconds * 1000;
      sessions.apply(waits(seconds, agentId));
      return decisions.create({
        sessionKey: KEY,
        kind: "permission",
        toolName: "Write",
        agentId,
        agentType: agentId ? "general-purpose" : undefined,
        concurrent: true,
      }).id as string;
    };
    return { sessions, decisions, ask };
  }

  it("records which agent asked, for display", () => {
    const { decisions, ask } = setup();
    ask(1, "agentA");
    expect(decisions.list()[0]).toMatchObject({ agentId: "agentA", agentType: "general-purpose" });
    ask(2);
    expect(decisions.list()[1]?.agentId).toBeUndefined();
  });

  it("another agent's activity does not cancel it; the same agent's does (after the grace)", () => {
    const { sessions, decisions, ask } = setup();
    const a = ask(1, "agentA");
    sessions.apply(event(10, { agentId: "agentB", message: "Edit" }));
    // Main-agent PostToolUse(Agent) while subagents run.
    sessions.apply(event(11, { message: "Agent" }));
    expect(decisions.list().map((d) => d.id)).toEqual([a]);

    sessions.apply(event(12, { agentId: "agentA", message: "Write" }));
    expect(decisions.list()).toEqual([]);
  });

  it("is cancelled by that subagent stopping", () => {
    const { sessions, decisions, ask } = setup();
    ask(1, "agentA");
    const b = ask(2, "agentB");
    sessions.apply(event(10, { agentId: "agentA", status: "done" }));
    expect(decisions.list().map((d) => d.id)).toEqual([b]);
  });

  it("is cancelled by the main agent's turn ending or a new prompt, whoever asked", () => {
    const first = setup();
    first.ask(1, "agentA");
    first.sessions.apply(event(10, { status: "done" }));
    expect(first.decisions.list()).toEqual([]);

    const second = setup();
    second.ask(1, "agentA");
    second.ask(2);
    second.sessions.apply(event(10, { status: "working", inputPending: false }));
    expect(second.decisions.list()).toEqual([]);
  });

  it("a main-agent decision is cancelled by main-agent activity but not by a subagent's", () => {
    const { sessions, decisions, ask } = setup();
    ask(1);
    sessions.apply(event(10, { agentId: "agentB", message: "Bash" }));
    expect(decisions.list()).toHaveLength(1);
    sessions.apply(event(11, { message: "Bash" }));
    expect(decisions.list()).toEqual([]);
  });

  it("is cancelled when the session ends", () => {
    const { sessions, decisions, ask } = setup();
    ask(1, "agentA");
    sessions.apply(event(10, { status: "ended" }));
    expect(decisions.list()).toEqual([]);
  });
});

describe("blocking decisions are not cancelled by session events", () => {
  function setup() {
    let clock = T0;
    const sessions = new SessionStore();
    const decisions = new DecisionStore({ now: () => clock, orphanMs: 10 * 60_000 });
    sessions.subscribe((change) => decisions.handleSessionChange(change));
    const ask = (seconds: number, agentId?: string) => {
      clock = T0 + seconds * 1000;
      sessions.apply(waits(seconds, agentId));
      return decisions.create({ sessionKey: KEY, kind: "permission", toolName: "Write", agentId })
        .id as string;
    };
    return { sessions, decisions, ask };
  }

  it("survives other-agent, main-agent, Notification, working and turn-end events", () => {
    const { sessions, decisions, ask } = setup();
    const a = ask(1, "agentA");
    sessions.apply(event(10, { agentId: "agentB", message: "Edit" }));
    sessions.apply(event(11, { message: "Bash" }));
    sessions.apply(event(12, { agentId: "agentA", message: "Write" }));
    sessions.apply(waits(13, "agentB"));
    sessions.apply(event(14, { status: "working", inputPending: false }));
    sessions.apply(event(15, { status: "done" }));
    expect(decisions.list().map((d) => d.id)).toEqual([a]);
  });

  it("still ends with the session", () => {
    const { sessions, decisions, ask } = setup();
    ask(1);
    sessions.apply(event(10, { status: "ended" }));
    expect(decisions.list()).toEqual([]);
    expect(decisions.debugLog().at(-1)?.end).toBe("session_end");
  });
});
