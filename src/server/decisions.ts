import { createHash, randomBytes } from "node:crypto";
import {
  type BackgroundHold,
  CONCURRENT_TTL_MS,
  DECISION_SHORT_HOLD_MS,
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
import { MAIN_AGENT_KEY } from "../core/types.js";

/**
 * Pending permission prompts and questions, kept in memory only (never in the session file): a command preview can
 * contain anything, and it is only worth showing while Claude is actually waiting.
 */

export type DecisionChange =
  | { type: "add"; decision: PendingDecision }
  /** Same decision, new expiry (a short hold became a full one). */
  | { type: "update"; decision: PendingDecision }
  | { type: "remove"; id: string };

export type WaitResult =
  | { type: "resolved"; resolution: Resolution }
  | { type: "timeout" }
  | { type: "gone" }
  | { type: "unknown" };

export type ResolveResult = "ok" | "unknown" | "gone" | "answered" | "invalid";

export type CreateResult = { id: string } | { id: null; reason: "session_cap" | "total_cap" | "invalid" };

export type DebugOutcome = "registered" | "no_viewer" | "unknown_session" | "cap" | "invalid";
export type DebugEnd =
  | "resolved_allow"
  | "resolved_deny"
  | "answered"
  | "cancelled_by_agent_event"
  | "cancelled_turn_end"
  | "session_end"
  | "expired_short"
  | "expired_full"
  | "orphan"
  /** No tab connected for the grace period. */
  | "no_viewer_cancel"
  /** Mode "off": every tab went to the background. */
  | "hidden_cancel";

/**
 * One line of the diagnostics ring buffer. Deliberately has no preview, command, question or plan text (AGENTS.md
 * rule 4): only enough to see why a prompt did or didn't get a card.
 */
export interface DebugRecord {
  at: string;
  tool: string;
  /** First 8 hex chars of a hash of the session key: enough to tell sessions apart, not the id itself. */
  session: string;
  kind: DecisionKind | "unknown";
  toolName: string;
  agentId: boolean;
  hostClass: "concurrent" | "blocking";
  outcome: DebugOutcome;
  end?: DebugEnd;
  endedAt?: string;
}

const DEBUG_MAX = 50;

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export interface DecisionStoreOptions {
  ttlMs?: number;
  /** Lifetime of a decision created with `concurrent: true`. */
  concurrentTtlMs?: number;
  /** Lifetime of a decision created with `hold: "short"` (only hidden tabs to show it to). */
  shortHoldMs?: number;
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
  /** The subagent asking; undefined: the main agent. */
  agentId?: string | undefined;
  agentType?: string | undefined;
  /** "short": nobody is looking at the dashboard right now, so only wait briefly (see `extendShortHolds`). */
  hold?: "full" | "short" | undefined;
  /**
   * The host shows its own prompt alongside the hook (see CONCURRENT_TTL_MS): long hold, ignores who is looking.
   */
  concurrent?: boolean | undefined;
  /** Blocking decisions: the background-hold setting at registration, shown on the card. */
  backgroundHold?: BackgroundHold | undefined;
  /** Adapter id, for diagnostics only. */
  tool?: string | undefined;
  /** Blocking only: cancelled as soon as no tab is visible, whatever the background-hold setting says. */
  visibleOnly?: boolean | undefined;
  /** Blocking only: a lifetime shorter than the default (never longer). */
  maxHoldMs?: number | undefined;
  preview?: string | undefined;
  questions?: DecisionQuestion[] | undefined;
}

interface Entry {
  decision: PendingDecision;
  concurrent: boolean;
  debug: DebugRecord;
  createdMs: number;
  /** Which agent of the session asked (`main` when none). */
  agentKey: string;
  short: boolean;
  /** This decision's full lifetime (the default, or the adapter's shorter cap). */
  ttlMs: number;
  visibleOnly: boolean;
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
  readonly #shortHoldMs: number;
  readonly #maxPerSession: number;
  readonly #maxTotal: number;
  readonly #now: () => number;
  readonly #orphanMs: number;
  readonly #concurrentTtlMs: number;
  readonly #debug: DebugRecord[] = [];

  constructor(options: DecisionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DECISION_TTL_MS;
    this.#concurrentTtlMs = options.concurrentTtlMs ?? CONCURRENT_TTL_MS;
    this.#shortHoldMs = Math.min(options.shortHoldMs ?? DECISION_SHORT_HOLD_MS, this.#ttlMs);
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

  /** The last attempts (newest last), copied. See DebugRecord for what is and isn't in them. */
  debugLog(): DebugRecord[] {
    return this.#debug.map((r) => ({ ...r }));
  }

  /** Logs an attempt that never became a decision (no viewer, unknown session, invalid body). */
  logRejected(input: NewDecision, outcome: Exclude<DebugOutcome, "registered">): void {
    this.#log(input, outcome);
  }

  #log(input: NewDecision, outcome: DebugOutcome): DebugRecord {
    const record: DebugRecord = {
      at: new Date(this.#now()).toISOString(),
      tool: truncate(input.tool ?? input.sessionKey.split(":")[0] ?? "", 64),
      session: shortHash(input.sessionKey),
      kind: input.kind,
      toolName: truncate(input.toolName, 100),
      agentId: input.agentId !== undefined,
      hostClass: input.concurrent === true ? "concurrent" : "blocking",
      outcome,
    };
    this.#debug.push(record);
    if (this.#debug.length > DEBUG_MAX) this.#debug.shift();
    return record;
  }

  #end(record: DebugRecord, end: DebugEnd): void {
    if (record.end) return; // the first reason wins (an answer is not overwritten by the cleanup after it)
    record.end = end;
    record.endedAt = new Date(this.#now()).toISOString();
  }

  create(input: NewDecision): CreateResult {
    const pending = this.list();
    if (pending.length >= this.#maxTotal) {
      this.#log(input, "cap");
      return { id: null, reason: "total_cap" };
    }
    if (pending.filter((d) => d.sessionKey === input.sessionKey).length >= this.#maxPerSession) {
      this.#log(input, "cap");
      return { id: null, reason: "session_cap" };
    }
    if (input.kind === "question" && !input.questions) {
      this.#log(input, "invalid");
      return { id: null, reason: "invalid" };
    }

    const id = randomBytes(18).toString("base64url");
    const createdMs = this.#now();
    const concurrent = input.concurrent === true;
    const short = !concurrent && input.hold === "short";
    const ttlMs =
      !concurrent && input.maxHoldMs !== undefined && input.maxHoldMs > 0
        ? Math.min(input.maxHoldMs, this.#ttlMs)
        : this.#ttlMs;
    const lifetime = concurrent ? this.#concurrentTtlMs : short ? Math.min(this.#shortHoldMs, ttlMs) : ttlMs;
    const decision: PendingDecision = {
      id,
      sessionKey: input.sessionKey,
      kind: input.kind,
      toolName: truncate(input.toolName, 100),
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(createdMs + lifetime).toISOString(),
    };
    if (input.agentId) {
      decision.agentId = input.agentId;
      if (input.agentType) decision.agentType = truncate(input.agentType, 64);
    }
    if (input.preview) {
      decision.preview = truncate(input.preview, input.kind === "plan" ? PLAN_PREVIEW_MAX : PREVIEW_MAX);
    }
    if (input.kind === "question" && input.questions) decision.questions = input.questions;
    if (concurrent) decision.concurrent = true;
    else if (input.backgroundHold) decision.backgroundHold = input.backgroundHold;
    // unref: a pending prompt must not keep the process alive.
    const timer = setTimeout(
      () =>
        this.#close(id, { type: "gone" }, this.#entries.get(id)?.short ? "expired_short" : "expired_full"),
      lifetime,
    );
    timer.unref();
    const entry: Entry = {
      decision,
      concurrent,
      debug: this.#log(input, "registered"),
      createdMs,
      agentKey: input.agentId ?? MAIN_AGENT_KEY,
      short,
      ttlMs,
      visibleOnly: !concurrent && input.visibleOnly === true,
      timer,
      waiters: new Set(),
    };
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
    this.#end(
      entry.debug,
      "answers" in resolution
        ? "answered"
        : resolution.behavior === "allow"
          ? "resolved_allow"
          : "resolved_deny",
    );
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

  /**
   * Cancels everything still unanswered, e.g. when no dashboard is being looked at any more. Concurrent decisions
   * are kept: their host shows its own prompt anyway, so nothing is being held back for a missing viewer.
   */
  cancelPending(reason: DebugEnd = "no_viewer_cancel", onlyVisibleOnly = false): void {
    for (const [id, entry] of this.#entries) {
      if (onlyVisibleOnly && !entry.visibleOnly) continue;
      if (!entry.resolution && !entry.concurrent) this.#close(id, { type: "gone" }, reason);
    }
  }

  /** Whether an unanswered blocking decision needs a visible tab (see `NewDecision.visibleOnly`). */
  hasVisibleOnly(): boolean {
    for (const entry of this.#entries.values()) if (!entry.resolution && entry.visibleOnly) return true;
    return false;
  }

  /** Whether any unanswered blocking decision exists (the viewer rules only concern those). */
  hasBlocking(): boolean {
    for (const entry of this.#entries.values()) if (!entry.resolution && !entry.concurrent) return true;
    return false;
  }

  /** A blocking decision of this session is pending: Claude Code is stopped in its hook, so nothing else can answer. */
  hasBlockingFor(sessionKey: string): boolean {
    for (const entry of this.#entries.values()) {
      if (!entry.resolution && !entry.concurrent && entry.decision.sessionKey === sessionKey) return true;
    }
    return false;
  }

  cancelSession(sessionKey: string): void {
    for (const [id, entry] of this.#entries) {
      if (entry.decision.sessionKey === sessionKey) this.#close(id, { type: "gone" }, "session_end");
    }
  }

  /** Nobody is looking any more (tabs hidden): full holds shrink to the short hold, counted from now. */
  shortenFullHolds(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.short || entry.resolution || entry.concurrent || entry.visibleOnly) continue;
      entry.short = true;
      const remaining = Math.max(Math.min(entry.createdMs + entry.ttlMs - now, this.#shortHoldMs), 1);
      this.#rearm(id, entry, remaining, now);
    }
  }

  #rearm(id: string, entry: Entry, remaining: number, now: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.#close(id, { type: "gone" }, entry.short ? "expired_short" : "expired_full"),
      remaining,
    );
    entry.timer.unref();
    entry.decision = { ...entry.decision, expiresAt: new Date(now + remaining).toISOString() };
    this.#emit({ type: "update", decision: entry.decision });
  }

  /** A tab became visible: decisions that were only held briefly get their full lifetime. */
  extendShortHolds(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (!entry.short || entry.resolution) continue;
      entry.short = false;
      this.#rearm(id, entry, Math.max(entry.createdMs + entry.ttlMs - now, 1), now);
    }
  }

  /**
   * Concurrent decisions: cancelled when the agent that asked moves on without us (the user answered in the host's
   * own prompt, so that agent is already working again). Other agents of the same session don't count (subagents
   * share the session id), unless the whole turn is over. Waiting for input again (the permission prompt's own
   * notification) is not moving on.
   *
   * Blocking decisions are never cancelled by events: while `decide` waits, Claude Code shows no prompt of its own,
   * so no one else can have answered, and any event (another agent, an approval-watch guess, a Notification) is
   * about something else. They end only by answer, orphan (Esc kills the hook), session end, expiry or viewer rules.
   */
  handleSessionChange(change: StoreChange): void {
    if (change.type === "remove") {
      this.cancelSession(change.key);
      return;
    }
    const { session, source } = change;
    // Changes that don't say which event caused them: any non-waiting session status is "moved on" (older callers).
    if (source ? source.status === "needs_input" : session.status === "needs_input") return;
    const updated = Date.parse(session.updatedAt);
    for (const [id, entry] of this.#entries) {
      if (!entry.concurrent || entry.decision.sessionKey !== session.key || entry.resolution) continue;
      if (source && !source.clearsAll && source.agentKey !== entry.agentKey) continue;
      if (updated > entry.createdMs + CANCEL_GRACE_MS) {
        this.#close(
          id,
          { type: "gone" },
          source?.clearsAll ? "cancelled_turn_end" : "cancelled_by_agent_event",
        );
      }
    }
  }

  /** Ends an entry. `notify`: what to tell anyone still waiting (null: they already have their answer). */
  #close(id: string, notify: WaitResult | null, reason?: DebugEnd): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (reason) this.#end(entry.debug, reason);
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
      if (entry.waiters.size === 0) this.#close(id, { type: "gone" }, "orphan");
    }, this.#orphanMs);
    entry.orphan.unref();
  }

  #emit(change: DecisionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}
