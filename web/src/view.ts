import { projectName, STATUS_ORDER, statusSince } from "./board";
import type { PendingDecision, Session } from "./useAgentStream";

/** "list" is the inbox plus project groups; "table" is the sortable command table. */
export type ViewMode = "list" | "table";

export const DEFAULT_VIEW: ViewMode = "list";

/** A stored value from another version or a hand-edited store falls back to the default. */
export function parseView(raw: string | null | undefined): ViewMode {
  return raw === "table" ? "table" : DEFAULT_VIEW;
}

export type StatusFilter = "all" | "needs" | "working" | "done";

export function parseStatusFilter(raw: string | null | undefined): StatusFilter {
  return raw === "needs" || raw === "working" || raw === "done" ? raw : "all";
}

export function matchesStatus(session: Session, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs":
      return session.status === "needs_input" || session.status === "error";
    case "working":
      return session.status === "working";
    case "done":
      return session.status === "done";
  }
}

/**
 * Case-insensitive search over what a person uses to tell sessions apart: task title, project folder name, host and
 * agent name. Every word must match somewhere, so "codex web" finds Codex sessions in a "web" project.
 */
export function matchesQuery(session: Session, query: string, toolLabel: string | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [session.title, projectName(session.cwd), session.host, toolLabel ?? session.tool]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export type SortKey = "status" | "agent" | "project" | "task" | "host" | "time";
export type SortDir = "asc" | "desc";
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: Sort = { key: "status", dir: "asc" };

/** Text columns start A to Z; time starts with the longest-waiting or newest first. */
export function firstDirection(key: SortKey): SortDir {
  return key === "time" ? "desc" : "asc";
}

/** Clicking the sorted column flips it; clicking another starts it in its natural direction. */
export function nextSort(current: Sort, key: SortKey): Sort {
  return current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: firstDirection(key) };
}

/** Compares two sessions by one column; ties fall back to the newest status change so the order is stable. */
export function compareSessions(
  a: Session,
  b: Session,
  sort: Sort,
  toolLabel: (session: Session) => string,
): number {
  const text = (s: string, t: string) => s.localeCompare(t, undefined, { sensitivity: "base" });
  let result = 0;
  switch (sort.key) {
    case "status":
      result = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      break;
    case "agent":
      result = text(toolLabel(a), toolLabel(b));
      break;
    case "project":
      result = text(projectName(a.cwd), projectName(b.cwd));
      break;
    case "task":
      result = text(a.title?.trim() ?? "", b.title?.trim() ?? "");
      break;
    case "host":
      result = text(a.host ?? "", b.host ?? "");
      break;
    case "time":
      result = statusSince(a).localeCompare(statusSince(b));
      break;
  }
  if (sort.dir === "desc") result = -result;
  return result || statusSince(b).localeCompare(statusSince(a)) || a.key.localeCompare(b.key);
}

export function sortSessions(
  sessions: Session[],
  sort: Sort,
  toolLabel: (session: Session) => string,
): Session[] {
  return [...sessions].sort((a, b) => compareSessions(a, b, sort, toolLabel));
}

export function statusCounts(sessions: Session[]): Record<StatusFilter, number> {
  return {
    all: sessions.length,
    needs: sessions.filter((s) => matchesStatus(s, "needs")).length,
    working: sessions.filter((s) => s.status === "working").length,
    done: sessions.filter((s) => s.status === "done").length,
  };
}

/** The tool a host name maps to when opening a session, or undefined when the dashboard can't open it. */
export function openTargetFor(host: string | undefined): string | undefined {
  if (host === "Codex Desktop") return "Codex";
  if (host === "Claude Desktop") return "Claude";
  if (host?.startsWith("VS Code")) return "VS Code";
  return undefined;
}

/**
 * A session with an unanswered prompt waiting on the dashboard needs you, whatever its last hook said (a tool can
 * report "working" while its prompt is open). An error stays an error: it is just as urgent and more specific.
 */
export function effectiveStatus(session: Session, decisions: readonly PendingDecision[]): Session["status"] {
  if (session.status === "error") return session.status;
  return decisions.some((d) => d.sessionKey === session.key) ? "needs_input" : session.status;
}

/**
 * The sessions as the dashboard should treat them: status replaced by effectiveStatus, and the "since" time moved
 * to when the prompt appeared so a long-running task doesn't claim to have been waiting for an hour. Sessions
 * without a pending decision are returned as the same objects.
 */
export function withDecisions(sessions: Session[], decisions: readonly PendingDecision[]): Session[] {
  if (decisions.length === 0) return sessions;
  return sessions.map((session) => {
    const mine = decisions.filter((d) => d.sessionKey === session.key);
    if (mine.length === 0 || effectiveStatus(session, decisions) === session.status) return session;
    const since = mine.map((d) => d.createdAt).sort()[0] ?? statusSince(session);
    return { ...session, status: "needs_input", statusSince: since };
  });
}

/**
 * Whether the section note about held-back terminal prompts applies: only while at least one pending prompt is
 * blocking (not also shown in its host).
 */
export function anyBlocking(decisions: readonly PendingDecision[]): boolean {
  return decisions.some((d) => d.concurrent !== true);
}

const WINDOWS_HOME = /^[A-Za-z]:\\Users\\[^\\]+/;
const POSIX_HOME = /^\/(Users|home)\/[^/]+/;

/**
 * A project folder short enough for a group header. The user's home is replaced with "~" when the path itself shows
 * where it is (no OS lookup). A path still longer than maxLength keeps its first segment and last two, with the
 * last one cut to fit. The full path belongs in a title attribute.
 */
export function shortenPath(path: string, maxLength = 48): string {
  const home = WINDOWS_HOME.exec(path) ?? POSIX_HOME.exec(path);
  const display = home ? `~${path.slice(home[0].length)}` : path;
  if (display.length <= maxLength) return display;

  const sep = display.includes("\\") ? "\\" : "/";
  const parts = display.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return display;

  const root = display.startsWith("/") && !home ? "/" : "";
  const first = `${root}${parts[0]}`;
  const near = parts[parts.length - 2] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const prefix = `${first}${sep}…${sep}${near}${sep}`;
  if (prefix.length + last.length <= maxLength) return prefix + last;

  const room = maxLength - prefix.length - 1;
  // Too little room for a useful tail: keep the whole last segment and let CSS ellipsize the rest.
  return room >= 6 ? `${prefix}${last.slice(0, room)}…` : `${first}${sep}…${sep}${last}`;
}
