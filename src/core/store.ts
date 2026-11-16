import { STALE_SESSION_MS } from "./constants.js";
import { readTextIfExists, writeFileAtomic } from "./fs.js";
import {
  type AgentEvent,
  type AgentStatus,
  MAIN_AGENT_KEY,
  type Session,
  sessionKey,
  UNATTRIBUTED_AGENT_ID,
} from "./types.js";

/** What one applied event meant for the agents in its session (decisions are cancelled by it). */
export interface ChangeSource {
  /** The agent the event came from (`main` when it carried no id). */
  agentKey: string;
  /** The event's own status (the session's can differ: another agent may still be waiting). */
  status: AgentStatus;
  /** A main-agent turn end or a new user prompt: every agent's pending input is over. */
  clearsAll: boolean;
}

export type StoreChange =
  | { type: "upsert"; session: Session; previousStatus: AgentStatus | null; source?: ChangeSource }
  | { type: "remove"; key: string };

/** A Notification and the PermissionRequest for the same prompt arrive within moments of each other. */
const SAME_PROMPT_MS = 5_000;
/** A subagent not heard from for this long no longer counts as running (it may have died without a stop hook). */
const SUBAGENT_ACTIVE_MS = 10 * 60_000;

type Listener = (change: StoreChange) => void;

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<Listener>();
  /** Per session: agents waiting for the user → when they started (event time). In memory only. */
  readonly #waiting = new Map<string, Map<string, string>>();
  /** Per session: subagents seen and not stopped → last event time (ms). In memory only. */
  readonly #subagents = new Map<string, Map<string, number>>();

  /** How many subagents of the session have been active recently (not stopped). */
  activeSubagents(key: string, nowMs: number = Date.now()): number {
    let count = 0;
    for (const seen of this.#subagents.get(key)?.values() ?? []) {
      if (nowMs - seen < SUBAGENT_ACTIVE_MS) count += 1;
    }
    return count;
  }

  list(): Session[] {
    return [...this.#sessions.values()]
      .filter((session) => !session.hidden)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(key: string): Session | undefined {
    const session = this.#sessions.get(key);
    return session?.hidden ? undefined : session;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Returns the change applied, or null if the event was ignored. */
  apply(event: AgentEvent): StoreChange | null {
    const key = sessionKey(event.tool, event.sessionId);
    const existing = this.#sessions.get(key);

    // A user can paste an internal marker into a real task. Only a fresh, untitled helper may hide.
    if (event.hidden && existing?.title && !existing.hidden) return null;

    // Hooks run as separate processes and can arrive out of order (e.g. a late "working" after "done").
    if (existing && event.timestamp < existing.updatedAt && !event.hidden) return null;

    if (event.status === "ended") {
      if (!existing) return null;
      // Keep the filter through a late background Stop or SessionStart from this helper session.
      if (existing.hidden) return null;
      return this.remove(key);
    }

    const agentKey = event.agentId ?? MAIN_AGENT_KEY;
    const isSubagent = agentKey !== MAIN_AGENT_KEY && agentKey !== UNATTRIBUTED_AGENT_ID;
    const waiting = this.#waiting.get(key) ?? new Map<string, string>();
    const eventMs = Date.parse(event.timestamp);
    const near = (since: string | undefined) =>
      since !== undefined && Math.abs(eventMs - Date.parse(since)) <= SAME_PROMPT_MS;

    if (event.status === "needs_input") {
      // The Notification for a prompt we already know about (from the PermissionRequest hook, which says which
      // agent asked) adds nothing; without that hook it is the only signal and is kept.
      if (agentKey === UNATTRIBUTED_AGENT_ID && [...waiting.values()].some(near)) return null;
      // The other order: the attributed event replaces the vague one for the same prompt.
      if (agentKey !== UNATTRIBUTED_AGENT_ID && near(waiting.get(UNATTRIBUTED_AGENT_ID))) {
        waiting.delete(UNATTRIBUTED_AGENT_ID);
      }
    }
    const subagentDone = isSubagent && event.status === "done";
    const clearsAll =
      event.status !== "needs_input" &&
      !subagentDone &&
      ((agentKey === MAIN_AGENT_KEY && event.status !== "working") || event.inputPending === false);
    if (event.status === "needs_input") waiting.set(agentKey, event.timestamp);
    else if (clearsAll) waiting.clear();
    else {
      // Only the agent that moved on is clear; an unattributed wait belongs to nobody, so anyone's activity ends it.
      waiting.delete(agentKey);
      waiting.delete(UNATTRIBUTED_AGENT_ID);
    }
    if (waiting.size > 0) this.#waiting.set(key, waiting);
    else this.#waiting.delete(key);
    if (isSubagent) {
      const subagents = this.#subagents.get(key) ?? new Map<string, number>();
      if (subagentDone) subagents.delete(agentKey);
      else subagents.set(agentKey, eventMs);
      if (subagents.size > 0) this.#subagents.set(key, subagents);
      else this.#subagents.delete(key);
    }
    const stillWaiting = waiting.size > 0;

    const inputPending = event.inputPending ?? existing?.inputPending;
    // A subagent finishing says nothing about the session itself: it stays as it was (or goes back to working
    // once nobody is waiting).
    const base: Exclude<AgentStatus, "ended"> = subagentDone
      ? existing && existing.status !== "needs_input"
        ? existing.status
        : "working"
      : event.status;
    const status =
      (inputPending || stillWaiting) && (base === "working" || base === "done" || base === "idle")
        ? "needs_input"
        : base;
    const session: Session = {
      key,
      tool: event.tool,
      sessionId: event.sessionId,
      // The project folder doesn't change within a session; a later event's cwd may be a subfolder the agent cd'd into.
      cwd: existing?.cwd ?? event.cwd,
      status,
      startedAt: existing?.startedAt ?? event.timestamp,
      updatedAt:
        event.hidden && existing && existing.updatedAt > event.timestamp
          ? existing.updatedAt
          : event.timestamp,
      statusSince:
        existing?.status === status ? (existing.statusSince ?? existing.updatedAt) : event.timestamp,
    };
    const previousActivityAt =
      existing?.status === status ? existing.previousActivityAt : existing?.updatedAt;
    if (previousActivityAt) session.previousActivityAt = previousActivityAt;
    // A pending question survives unrelated background activity; ordinary activity messages don't.
    if (inputPending) {
      session.inputPending = true;
      const message = event.inputPending === true ? event.message : existing?.message;
      if (message) session.message = message;
    } else if (stillWaiting && event.status !== "needs_input") {
      // Another agent is still waiting: its message stays up, not this agent's activity line.
      if (existing?.message && existing.status === "needs_input") session.message = existing.message;
    } else if (subagentDone) {
      if (existing?.message && existing.status === status) session.message = existing.message;
    } else if (event.message) session.message = event.message;
    // The tool's own name for the session wins and stays current, like the tab name in VS Code. A
    // prompt-derived title only fills in until then, and the first one sticks.
    if (event.title && event.titleSource === "tool") {
      session.title = event.title;
      session.titleSource = "tool";
    } else if (existing?.title) {
      session.title = existing.title;
      if (existing.titleSource) session.titleSource = existing.titleSource;
    } else if (event.title) {
      session.title = event.title;
    }
    const pid = event.pid ?? existing?.pid;
    if (pid) session.pid = pid;
    const host = event.host ?? existing?.host;
    if (host) session.host = host;

    this.#sessions.set(key, session);
    if (event.hidden || existing?.hidden) {
      session.hidden = true;
      delete session.title;
      delete session.titleSource;
      if (existing?.hidden) return null;
      const change: StoreChange = { type: "remove", key };
      this.#emit(change);
      return change;
    }
    const change: StoreChange = {
      type: "upsert",
      session,
      previousStatus: existing?.status ?? null,
      source: { agentKey, status: event.status, clearsAll },
    };
    this.#emit(change);
    return change;
  }

  /** Marks a working session as stalled without counting as activity (updatedAt and status stay). */
  markStalled(key: string): StoreChange | null {
    const existing = this.#sessions.get(key);
    if (existing?.status !== "working" || existing.stalled || existing.hidden) return null;
    const session: Session = { ...existing, stalled: true };
    this.#sessions.set(key, session);
    const change: StoreChange = { type: "upsert", session, previousStatus: existing.status };
    this.#emit(change);
    return change;
  }

  remove(key: string): StoreChange | null {
    this.#waiting.delete(key);
    this.#subagents.delete(key);
    if (!this.#sessions.delete(key)) return null;
    const change: StoreChange = { type: "remove", key };
    this.#emit(change);
    return change;
  }

  pruneStale(now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - STALE_SESSION_MS).toISOString();
    for (const session of this.#sessions.values()) {
      if (session.updatedAt < cutoff) this.remove(session.key);
    }
  }

  async load(path: string): Promise<void> {
    const text = await readTextIfExists(path);
    if (text === null) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed as Session[]) {
        if (item && typeof item.key === "string" && typeof item.updatedAt === "string") {
          // Sessions saved by older versions have no statusSince.
          this.#sessions.set(item.key, { ...item, statusSince: item.statusSince ?? item.updatedAt });
        }
      }
    } catch {
      // A corrupt state file only costs us the session list; start empty.
    }
    this.pruneStale();
  }

  async save(path: string): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify([...this.#sessions.values()], null, 2)}\n`);
  }

  #emit(change: StoreChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}
