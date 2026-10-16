import { STALE_SESSION_MS } from "./constants.js";
import { readTextIfExists, writeFileAtomic } from "./fs.js";
import { type AgentEvent, type AgentStatus, type Session, sessionKey } from "./types.js";

export type StoreChange =
  | { type: "upsert"; session: Session; previousStatus: AgentStatus | null }
  | { type: "remove"; key: string };

type Listener = (change: StoreChange) => void;

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Set<Listener>();

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

    const inputPending = event.inputPending ?? existing?.inputPending;
    const status =
      inputPending && (event.status === "working" || event.status === "done" || event.status === "idle")
        ? "needs_input"
        : event.status;
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
    const change: StoreChange = { type: "upsert", session, previousStatus: existing?.status ?? null };
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
