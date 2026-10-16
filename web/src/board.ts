import type { Session } from "./useAgentStream";

export type Status = Session["status"];

/** When the session entered its current status. A server started before the field existed omits it. */
export function statusSince(session: Session): string {
  return (session.statusSince as string | undefined) ?? session.updatedAt;
}

/** Working, but no event for 10+ minutes (set by the server). */
export function isStalled(session: Session): boolean {
  return session.stalled === true;
}

/**
 * A permission prompt the server can't follow: without a pid it can't notice the approved command
 * starting, only finishing. Other waits (a question, an idle prompt) need no hint.
 */
export function needsApprovalHint(session: Session): boolean {
  return (
    session.status === "needs_input" &&
    session.pid === undefined &&
    /permission|approv/i.test(session.message ?? "")
  );
}

export function needsYou(session: Session): boolean {
  return session.status === "needs_input" || session.status === "error";
}

export function isFinished(session: Session): boolean {
  return session.status === "done";
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/**
 * The server sends cwd with its on-disk casing; folding Windows drive paths here as well keeps c:\x and
 * C:\x together for sessions saved before it did.
 */
function projectKey(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return /^[a-z]:[\\/]/i.test(trimmed) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

const STATUS_ORDER: Record<Status, number> = { needs_input: 0, error: 1, working: 2, idle: 3, done: 4 };

function byUrgency(a: Session, b: Session): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || statusSince(b).localeCompare(statusSince(a));
}

export interface Project {
  key: string;
  name: string;
  cwd: string;
  sessions: Session[];
}

/** Projects with the most urgent session first, then the most recently active. */
export function groupByProject(sessions: Session[]): Project[] {
  const projects = new Map<string, Project>();
  for (const session of sessions) {
    const key = projectKey(session.cwd);
    const project = projects.get(key);
    if (project) project.sessions.push(session);
    else projects.set(key, { key, name: projectName(session.cwd), cwd: session.cwd, sessions: [session] });
  }
  const list = [...projects.values()];
  for (const project of list) project.sessions.sort(byUrgency);
  const lead = (p: Project) => p.sessions[0] as Session;
  const latest = (p: Project) => p.sessions.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), "");
  return list.sort(
    (a, b) =>
      STATUS_ORDER[lead(a).status] - STATUS_ORDER[lead(b).status] || latest(b).localeCompare(latest(a)),
  );
}

export function sortByUrgency(sessions: Session[]): Session[] {
  return [...sessions].sort(byUrgency);
}

export function duration(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 >= 5 && hours < 6 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** "Working for 4m", "Waiting 7m", "Finished 13m ago": how long it has been like this. */
export function statusDuration(session: Session, now: number): string {
  const time = duration(statusSince(session), now);
  const recent = time === "just now";
  switch (session.status) {
    case "working":
      return recent ? "Started just now" : `Working for ${time}`;
    case "needs_input":
      return recent ? "Waiting since just now" : `Waiting ${time}`;
    case "error":
      return recent ? "Stopped just now" : `Stopped ${time} ago`;
    case "done":
      return recent ? "Finished just now" : `Finished ${time} ago`;
    case "idle":
      return recent ? "Idle" : `Idle for ${time}`;
  }
}
