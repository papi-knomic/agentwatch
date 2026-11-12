import { randomBytes } from "node:crypto";
import {
  DECISION_TTL_MS,
  type DecisionKind,
  type DecisionQuestion,
  type PendingDecision,
  PLAN_FEEDBACK_MAX,
  PLAN_PREVIEW_MAX,
  PREVIEW_MAX,
  type Resolution,
  truncate,
  validateAnswers,
} from "../core/decision-types.js";
import type { StoreChange } from "../core/store.js";

/**
 * Pending permission prompts and questions, kept in memory only (never in the session file): a command preview can
 * contain anything, and it is only worth showing while Claude is actually waiting.
 */

export type DecisionChange = { type: "add"; decision: PendingDecision } | { type: "remove"; id: string };

export type WaitResult =
  | { type: "resolved"; resolution: Resolution }
  | { type: "timeout" }
  | { type: "gone" }
  | { type: "unknown" };

export type ResolveResult = "ok" | "unknown" | "gone" | "answered" | "invalid";

export type CreateResult = { id: string } | { id: null; reason: "session_cap" | "total_cap" | "invalid" };

export interface DecisionStoreOptions {
  ttlMs?: number;
  maxPerSession?: number;
  maxTotal?: number;
  now?: () => number;
  /**
   * How long a decision may go without a `wait` request attached (from creation, or since the last one ended)
   * before it is cancelled. `decide` polls back to back, so a longer gap means it is no longer listening.
   */
  orphanMs?: number;
}

export interface NewDecision {
  sessionKey: string;
  kind: DecisionKind;
  toolName: string;
  preview?: string | undefined;
  questions?: DecisionQuestion[] | undefined;
}

interface Entry {
  decision: PendingDecision;
  createdMs: number;
  resolution?: Resolution;
  timer: NodeJS.Timeout;
  orphan?: NodeJS.Timeout;
  waiters: Set<(result: WaitResult) => void>;
}

/**
 * A hook can fire a moment before the event for the previous tool call arrives. Events this close to the request
 * are not taken as "the user answered in the terminal".
 */
const CANCEL_GRACE_MS = 1500;
const MAX_TOMBSTONES = 500;
const DEFAULT_ORPHAN_MS = 3000;

export class DecisionStore {
  readonly #entries = new Map<string, Entry>();
  /** Ids that existed and are over (expired, cancelled, answered), so callers get "gone" rather than "unknown". */
  readonly #closed = new Set<string>();
  readonly #listeners = new Set<(change: DecisionChange) => void>();
  readonly #ttlMs: number;
  readonly #maxPerSession: number;
  readonly #maxTotal: number;
  readonly #now: () => number;
  readonly #orphanMs: number;

  constructor(options: DecisionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DECISION_TTL_MS;
    this.#maxPerSession = options.maxPerSession ?? 5;
    this.#maxTotal = options.maxTotal ?? 50;
    this.#now = options.now ?? Date.now;
    this.#orphanMs = options.orphanMs ?? DEFAULT_ORPHAN_MS;
  }

  /** Decisions still waiting for an answer. */
  list(): PendingDecision[] {
    return [...this.#entries.values()].filter((e) => !e.resolution).map((e) => e.decision);
  }

  subscribe(listener: (change: DecisionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  create(input: NewDecision): CreateResult {
    const pending = this.list();
    if (pending.length >= this.#maxTotal) return { id: null, reason: "total_cap" };
    if (pending.filter((d) => d.sessionKey === input.sessionKey).length >= this.#maxPerSession) {
      return { id: null, reason: "session_cap" };
    }
    if (input.kind === "question" && !input.questions) return { id: null, reason: "invalid" };

    const id = randomBytes(18).toString("base64url");
    const createdMs = this.#now();
    const decision: PendingDecision = {
      id,
      sessionKey: input.sessionKey,
      kind: input.kind,
      toolName: truncate(input.toolName, 100),
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(createdMs + this.#ttlMs).toISOString(),
    };
    if (input.preview) {
      decision.preview = truncate(input.preview, input.kind === "plan" ? PLAN_PREVIEW_MAX : PREVIEW_MAX);
    }
    if (input.kind === "question" && input.questions) decision.questions = input.questions;
    // unref: a pending prompt must not keep the process alive.
    const timer = setTimeout(() => this.#close(id, { type: "gone" }), this.#ttlMs);
    timer.unref();
    const entry: Entry = { decision, createdMs, timer, waiters: new Set() };
    this.#entries.set(id, entry);
    this.#armOrphan(id, entry);
    this.#emit({ type: "add", decision });
    return { id };
  }

  /** Records the dashboard's answer. Validated against what was asked; the first answer wins. */
  resolve(id: string, body: unknown): ResolveResult {
    const entry = this.#entries.get(id);
    if (!entry) return this.#closed.has(id) ? "gone" : "unknown";
    if (entry.resolution) return "answered";
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    let resolution: Resolution;
    if (entry.decision.kind === "plan") {
      if (record.behavior === "allow") resolution = { behavior: "allow" };
      else if (record.behavior === "deny") {
        const message = record.message;
        if (message === undefined) resolution = { behavior: "deny" };
        else if (typeof message === "string" && message.length <= PLAN_FEEDBACK_MAX) {
          // Whitespace-only feedback is "no feedback": the hook then sends its default text.
          resolution = message.trim() === "" ? { behavior: "deny" } : { behavior: "deny", message };
        } else return "invalid";
      } else return "invalid";
    } else if (entry.decision.kind === "permission") {
      if (record.behavior !== "allow" && record.behavior !== "deny") return "invalid";
      resolution = { behavior: record.behavior };
    } else {
      const answers = validateAnswers(entry.decision.questions ?? [], record.answers);
      if (!answers) return "invalid";
      resolution = { answers };
    }
    entry.resolution = resolution;
    this.#emit({ type: "remove", id });
    for (const waiter of [...entry.waiters]) waiter({ type: "resolved", resolution });
    return "ok";
  }

  /**
   * Long-poll: resolves with the answer, "timeout" if nothing came in time, or "gone" once expired or cancelled.
   * `signal` drops the wait when the caller disconnects. An answer is NOT consumed here: the caller calls
   * `consume` once it has really written the answer to a live response, so a poll whose socket just closed does
   * not swallow it (the next poll gets it, until the decision expires).
   */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<WaitResult> {
    const entry = this.#entries.get(id);
    if (!entry) return Promise.resolve({ type: this.#closed.has(id) ? "gone" : "unknown" });
    if (entry.resolution) {
      // Undelivered until `consume`; if the caller never gets it out, the orphan timer ends it.
      this.#armOrphan(id, entry);
      return Promise.resolve({ type: "resolved", resolution: entry.resolution });
    }
    clearTimeout(entry.orphan);
    return new Promise((resolve) => {
      const done = (result: WaitResult) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        entry.waiters.delete(done);
        if (entry.waiters.size === 0 && this.#entries.get(id) === entry) this.#armOrphan(id, entry);
        resolve(result);
      };
      const onAbort = () => done({ type: "timeout" });
      const timeout = setTimeout(() => done({ type: "timeout" }), ms);
      entry.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The caller has written the answer to a live response: the id is one-shot, so it is over now. */
  consume(id: string): void {
    if (this.#entries.get(id)?.resolution) this.#close(id, null);
  }

  /** Cancels everything still unanswered, e.g. when no dashboard is being looked at any more. */
  cancelPending(): void {
    for (const [id, entry] of this.#entries) {
      if (!entry.resolution) this.#close(id, { type: "gone" });
    }
  }

  cancelSession(sessionKey: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.decision.sessionKey === sessionKey) this.#close(id, { type: "gone" });
    }
  }

  /**
   * Cancels a session's pending decisions when it moves on without us: the user answered in the terminal (or the
   * app), so Claude is already working again. Waiting for input again (the permission prompt's own notification)
   * is not moving on.
   */
  handleSessionChange(change: StoreChange): void {
    if (change.type === "remove") {
      this.cancelSession(change.key);
      return;
    }
    const { session } = change;
    if (session.status === "needs_input") return;
    const updated = Date.parse(session.updatedAt);
    for (const [id, entry] of this.#entries) {
      if (entry.decision.sessionKey !== session.key || entry.resolution) continue;
      if (updated > entry.createdMs + CANCEL_GRACE_MS) this.#close(id, { type: "gone" });
    }
  }

  /** Ends an entry. `notify`: what to tell anyone still waiting (null: they already have their answer). */
  #close(id: string, notify: WaitResult | null): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.orphan);
    this.#entries.delete(id);
    this.#closed.add(id);
    if (this.#closed.size > MAX_TOMBSTONES) {
      const oldest = this.#closed.values().next().value;
      if (oldest !== undefined) this.#closed.delete(oldest);
    }
    if (notify) for (const waiter of [...entry.waiters]) waiter(notify);
    if (!entry.resolution) this.#emit({ type: "remove", id });
  }

  #armOrphan(id: string, entry: Entry): void {
    clearTimeout(entry.orphan);
    entry.orphan = setTimeout(() => {
      if (entry.waiters.size === 0) this.#close(id, { type: "gone" });
    }, this.#orphanMs);
    entry.orphan.unref();
  }

  #emit(change: DecisionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}
