import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionQuestion,
  parseQuestions,
  previewFor,
  validateAnswers,
} from "../core/decision-types.js";
import type { Session } from "../core/types.js";
import { DecisionStore } from "./decisions.js";

const QUESTIONS: DecisionQuestion[] = [
  {
    question: "Which database?",
    header: "DB",
    multiSelect: false,
    options: [{ label: "SQLite" }, { label: "Postgres", description: "server" }],
  },
  {
    question: "Extras?",
    multiSelect: true,
    options: [{ label: "Lint" }, { label: "CI" }, { label: "Docs" }],
  },
];

describe("plan decisions", () => {
  const planStore = () => {
    const store = new DecisionStore();
    const created = store.create({
      sessionKey: "claude-code:s",
      kind: "plan",
      toolName: "ExitPlanMode",
      preview: "p".repeat(5000),
    });
    return { store, id: created.id as string };
  };

  it("keeps up to 4000 chars of the plan", () => {
    const { store } = planStore();
    expect(store.list()[0]?.preview?.length).toBe(4000);
  });

  it("accepts allow, and deny with optional feedback up to 1000 chars", async () => {
    let { store, id } = planStore();
    expect(store.resolve(id, { behavior: "allow" })).toBe("ok");
    ({ store, id } = planStore());
    expect(store.resolve(id, { behavior: "deny", message: "x".repeat(1001) })).toBe("invalid");
    expect(store.resolve(id, { behavior: "deny", message: 5 })).toBe("invalid");
    expect(store.resolve(id, { behavior: "maybe" })).toBe("invalid");
    expect(store.resolve(id, { answers: {} })).toBe("invalid");
    expect(store.resolve(id, { behavior: "deny", message: "x".repeat(1000) })).toBe("ok");
    await expect(store.wait(id, 10)).resolves.toEqual({
      type: "resolved",
      resolution: { behavior: "deny", message: "x".repeat(1000) },
    });
    ({ store, id } = planStore());
    expect(store.resolve(id, { behavior: "deny", message: "   " })).toBe("ok");
    await expect(store.wait(id, 10)).resolves.toEqual({ type: "resolved", resolution: { behavior: "deny" } });
  });
});

describe("previewFor", () => {
  it("shows the command for Bash and the path for file tools", () => {
    expect(previewFor("Bash", { command: "npm test", description: "x" })).toBe("npm test");
    expect(previewFor("Write", { file_path: "C:\\p\\a.ts", content: "SECRET" })).toBe("C:\\p\\a.ts");
    expect(previewFor("Edit", { file_path: "a.ts", old_string: "SECRET" })).toBe("a.ts");
  });

  it("truncates to 300 chars, and plans to 4000", () => {
    expect(previewFor("Bash", { command: "x".repeat(1000) })?.length).toBe(300);
    expect(previewFor("ExitPlanMode", { plan: "p".repeat(5000) })?.length).toBe(4000);
  });

  it("falls back to compact JSON for other tools, and to nothing for empty input", () => {
    expect(previewFor("WebFetch", { url: "https://example.com" })).toBe('{"url":"https://example.com"}');
    expect(previewFor("Bash", {})).toBeUndefined();
    expect(previewFor("Bash", { command: "" })).toBe('{"command":""}');
  });
});

describe("parseQuestions", () => {
  it("accepts AskUserQuestion's shape and truncates descriptions", () => {
    const parsed = parseQuestions([
      {
        question: "Q?",
        header: "H",
        multiSelect: true,
        options: [{ label: "A", description: "d".repeat(900) }],
      },
    ]);
    expect(parsed?.[0]?.multiSelect).toBe(true);
    expect(parsed?.[0]?.options[0]?.description?.length).toBe(300);
  });

  it("rejects multi-select questions whose labels contain a comma, but not single-select ones", () => {
    const options = [{ label: "Red, green" }, { label: "Blue" }];
    expect(parseQuestions([{ question: "Q", multiSelect: true, options }])).toBeNull();
    expect(parseQuestions([{ question: "Q", multiSelect: false, options }])).not.toBeNull();
  });

  it("rejects what it cannot show exactly", () => {
    expect(parseQuestions([])).toBeNull();
    expect(parseQuestions("x")).toBeNull();
    expect(parseQuestions([{ question: "Q", options: [] }])).toBeNull();
    expect(parseQuestions([{ question: "Q", options: [{ label: "A" }, { label: "A" }] }])).toBeNull();
    expect(parseQuestions([{ question: "Q".repeat(501), options: [{ label: "A" }] }])).toBeNull();
    expect(parseQuestions([{ question: "Q", options: [{ label: "A".repeat(201) }] }])).toBeNull();
    const q = { question: "Same", options: [{ label: "A" }] };
    expect(parseQuestions([q, q])).toBeNull();
  });
});

describe("validateAnswers", () => {
  it("accepts one label per single-select question and joins multi-select labels in option order", () => {
    expect(validateAnswers(QUESTIONS, { "Which database?": "SQLite", "Extras?": ["CI", "Lint"] })).toEqual({
      "Which database?": "SQLite",
      "Extras?": "Lint, CI",
    });
    expect(validateAnswers(QUESTIONS, { "Which database?": "Postgres", "Extras?": "Docs" })).toEqual({
      "Which database?": "Postgres",
      "Extras?": "Docs",
    });
  });

  it("rejects missing, unknown, extra, empty and malformed answers", () => {
    expect(validateAnswers(QUESTIONS, { "Which database?": "SQLite" })).toBeNull();
    expect(validateAnswers(QUESTIONS, { "Which database?": "Mongo", "Extras?": "CI" })).toBeNull();
    expect(validateAnswers(QUESTIONS, { "Which database?": "SQLite", "Extras?": [] })).toBeNull();
    expect(validateAnswers(QUESTIONS, { "Which database?": "SQLite", "Extras?": ["CI", "CI"] })).toBeNull();
    expect(validateAnswers(QUESTIONS, { "Which database?": ["SQLite"], "Extras?": "CI" })).toBeNull();
    expect(
      validateAnswers(QUESTIONS, { "Which database?": "SQLite", "Extras?": "CI", Extra: "x" }),
    ).toBeNull();
    expect(validateAnswers(QUESTIONS, ["SQLite"])).toBeNull();
    expect(validateAnswers(QUESTIONS, null)).toBeNull();
  });
});

describe("DecisionStore", () => {
  let store: DecisionStore;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.parse("2026-11-11T12:00:00.000Z");
    vi.setSystemTime(clock);
    store = new DecisionStore({ ttlMs: 10_000, maxPerSession: 2, maxTotal: 3, now: () => Date.now() });
  });
  afterEach(() => vi.useRealTimers());

  const permission = (sessionKey = "claude-code:s1") =>
    store.create({ sessionKey, kind: "permission", toolName: "Bash", preview: "npm test" });

  function sessionAt(offsetMs: number, status: Session["status"], key = "claude-code:s1"): Session {
    const at = new Date(clock + offsetMs).toISOString();
    return {
      key,
      tool: "claude-code",
      sessionId: key.split(":")[1] ?? "",
      cwd: "C:\\p",
      status,
      startedAt: at,
      updatedAt: at,
      statusSince: at,
    };
  }

  it("creates unguessable ids and lists the pending decision", () => {
    const a = permission();
    const b = permission();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a.id).not.toBe(b.id);
    expect(store.list()).toHaveLength(2);
    expect(store.list()[0]).toMatchObject({ kind: "permission", toolName: "Bash", preview: "npm test" });
  });

  it("caps pending decisions per session and overall", () => {
    permission();
    permission();
    expect(permission()).toEqual({ id: null, reason: "session_cap" });
    permission("claude-code:s2");
    expect(permission("claude-code:s3")).toEqual({ id: null, reason: "total_cap" });
  });

  it("needs questions for a question", () => {
    expect(store.create({ sessionKey: "k", kind: "question", toolName: "AskUserQuestion" })).toEqual({
      id: null,
      reason: "invalid",
    });
  });

  it("hands a waiting caller the answer, once", async () => {
    const { id } = permission();
    const waiting = store.wait(id as string, 5_000);
    expect(store.resolve(id as string, { behavior: "allow" })).toBe("ok");
    await expect(waiting).resolves.toEqual({ type: "resolved", resolution: { behavior: "allow" } });
    expect(store.list()).toEqual([]);
    // Not consumed until the caller says the answer was really written out.
    expect(store.resolve(id as string, { behavior: "deny" })).toBe("answered");
    await expect(store.wait(id as string, 10)).resolves.toMatchObject({ type: "resolved" });
    store.consume(id as string);
    expect(store.resolve(id as string, { behavior: "deny" })).toBe("gone");
    await expect(store.wait(id as string, 10)).resolves.toEqual({ type: "gone" });
  });

  it("keeps an answer that arrives between polls, and rejects a second answer", async () => {
    const { id } = permission();
    expect(store.resolve(id as string, { behavior: "deny" })).toBe("ok");
    expect(store.resolve(id as string, { behavior: "allow" })).toBe("answered");
    await expect(store.wait(id as string, 10)).resolves.toEqual({
      type: "resolved",
      resolution: { behavior: "deny" },
    });
  });

  it("validates the answer against what was asked", () => {
    const perm = permission().id as string;
    expect(store.resolve(perm, { behavior: "maybe" })).toBe("invalid");
    expect(store.resolve(perm, { answers: {} })).toBe("invalid");
    expect(store.resolve(perm, undefined)).toBe("invalid");
    const q = store.create({
      sessionKey: "claude-code:s2",
      kind: "question",
      toolName: "AskUserQuestion",
      questions: QUESTIONS,
    }).id as string;
    expect(store.resolve(q, { behavior: "allow" })).toBe("invalid");
    expect(store.resolve(q, { answers: { "Which database?": "Mongo", "Extras?": "CI" } })).toBe("invalid");
    expect(store.resolve(q, { answers: { "Which database?": "SQLite", "Extras?": ["CI"] } })).toBe("ok");
  });

  it("times a wait out without ending the decision", async () => {
    const { id } = permission();
    const waiting = store.wait(id as string, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ type: "timeout" });
    expect(store.list()).toHaveLength(1);
  });

  it("expires after the deadline", async () => {
    const { id } = permission();
    const waiting = store.wait(id as string, 60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waiting).resolves.toEqual({ type: "gone" });
    expect(store.list()).toEqual([]);
    expect(store.resolve(id as string, { behavior: "allow" })).toBe("gone");
  });

  it("knows nothing about ids it never issued", async () => {
    expect(store.resolve("nope", { behavior: "allow" })).toBe("unknown");
    await expect(store.wait("nope", 10)).resolves.toEqual({ type: "unknown" });
  });

  it("is cancelled by newer activity on the session (answered in the terminal)", async () => {
    const { id } = permission();
    const waiting = store.wait(id as string, 60_000);
    // Waiting for input again is the permission prompt's own notification, not an answer.
    store.handleSessionChange({
      type: "upsert",
      session: sessionAt(5_000, "needs_input"),
      previousStatus: "working",
    });
    expect(store.list()).toHaveLength(1);
    // Late event for the tool call before this one.
    store.handleSessionChange({ type: "upsert", session: sessionAt(100, "working"), previousStatus: null });
    expect(store.list()).toHaveLength(1);
    // Another session is unaffected.
    store.handleSessionChange({
      type: "upsert",
      session: sessionAt(9_000, "working", "claude-code:other"),
      previousStatus: null,
    });
    expect(store.list()).toHaveLength(1);

    store.handleSessionChange({ type: "upsert", session: sessionAt(8_000, "working"), previousStatus: null });
    await expect(waiting).resolves.toEqual({ type: "gone" });
    expect(store.list()).toEqual([]);
  });

  it("is cancelled by a finished turn and by the session ending", async () => {
    const a = permission().id as string;
    store.handleSessionChange({ type: "upsert", session: sessionAt(8_000, "done"), previousStatus: null });
    await expect(store.wait(a, 10)).resolves.toEqual({ type: "gone" });

    const b = permission().id as string;
    store.handleSessionChange({ type: "remove", key: "claude-code:s1" });
    await expect(store.wait(b, 10)).resolves.toEqual({ type: "gone" });
  });

  it("cancels a decision nobody ever starts waiting for, and one whose waiter went away", async () => {
    const never = permission().id as string;
    await vi.advanceTimersByTimeAsync(2_900);
    expect(store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.list()).toEqual([]);
    await expect(store.wait(never, 10)).resolves.toEqual({ type: "gone" });

    // A waiter keeps it alive however long it polls; the gap after it ends is what counts.
    const polled = permission().id as string;
    const waiting = store.wait(polled, 8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(waiting).resolves.toEqual({ type: "timeout" });
    const second = store.wait(polled, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(store.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(store.list()).toEqual([]);
  });

  it("keeps an answer the poll did not take, until the next poll consumes it or it runs out", async () => {
    const id = permission().id as string;
    const first = store.wait(id, 5_000);
    store.resolve(id, { behavior: "allow" });
    await expect(first).resolves.toMatchObject({ type: "resolved" });
    // The caller's socket was gone: no consume. A prompt retry still gets the answer...
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(store.wait(id, 10)).resolves.toEqual({
      type: "resolved",
      resolution: { behavior: "allow" },
    });
    // ...but a caller that never comes back does not leave it around.
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(store.wait(id, 10)).resolves.toEqual({ type: "gone" });
  });

  it("cancelPending ends only unanswered decisions", async () => {
    const open = permission().id as string;
    const answered = permission().id as string;
    store.resolve(answered, { behavior: "allow" });
    store.cancelPending();
    await expect(store.wait(open, 10)).resolves.toEqual({ type: "gone" });
    await expect(store.wait(answered, 10)).resolves.toMatchObject({ type: "resolved" });
  });

  it("announces additions and removals", () => {
    const seen: string[] = [];
    store.subscribe((c) => seen.push(c.type));
    const { id } = permission();
    store.resolve(id as string, { behavior: "allow" });
    expect(seen).toEqual(["add", "remove"]);
  });

  it("drops a wait when its caller disconnects", async () => {
    const { id } = permission();
    const controller = new AbortController();
    const waiting = store.wait(id as string, 60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual({ type: "timeout" });
  });
});
