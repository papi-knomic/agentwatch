import { MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH } from "./constants.js";

export const AGENT_STATUSES = ["idle", "working", "needs_input", "done", "error", "ended"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Statuses that can trigger a desktop notification. */
export const NOTIFIABLE_STATUSES = ["needs_input", "done", "error"] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export type TitleSource = "tool" | "prompt";

/** The contract between adapters and core. Every tool's raw hook payload is normalized into this. */
export interface AgentEvent {
  tool: string;
  sessionId: string;
  /** The project folder (the session's root, not the shell's current directory). The first one sticks. */
  cwd: string;
  status: AgentStatus;
  message?: string;
  /**
   * The session's task name: the tool's own session title, or the start of the first prompt.
   * The only prompt-derived data kept; users can turn it off with `taskTitles: false`.
   */
  title?: string;
  /**
   * "tool": the tool's own name for the session (generated or set by the user); it replaces any earlier
   * title and stays current. "prompt" (the default): derived from a prompt; only fills in until the tool
   * names the session, and the first one sticks.
   */
  titleSource?: TitleSource;
  /** Where the agent runs, e.g. "VS Code", "Windows Terminal", "Claude Desktop". */
  host?: string;
  /**
   * The agent's process id, when the tool exposes it (Claude Code: CLAUDE_PID). Lets the server notice an
   * approved command starting, since no tool fires a hook on approval.
   */
  pid?: number;
  /** An outstanding question; background work must not clear it before the user's reply. */
  inputPending?: boolean;
  /** Internal helper sessions are retained for filtering later events, but never displayed or notified. */
  hidden?: boolean;
  timestamp: string;
}

export interface Session {
  key: string;
  tool: string;
  sessionId: string;
  cwd: string;
  status: Exclude<AgentStatus, "ended">;
  message?: string;
  title?: string;
  titleSource?: TitleSource;
  host?: string;
  pid?: number;
  inputPending?: boolean;
  hidden?: boolean;
  startedAt: string;
  /** Last event of any kind. */
  updatedAt: string;
  /** When the session entered its current status; what "how long has this been waiting" is measured from. */
  statusSince: string;
  /**
   * The last event before the current status began (for needs_input: the activity just before the prompt).
   * The approval watcher counts any shell started after it, since our "needs input" hook can arrive after the
   * user has already approved.
   */
  previousActivityAt?: string;
  /** Working, but no event for a long time: maybe stuck, maybe a very long command. Cleared by any event. */
  stalled?: boolean;
}

export function sessionKey(tool: string, sessionId: string): string {
  return `${tool}:${sessionId}`;
}

export function truncateMessage(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine === "") return undefined;
  return oneLine.length > MAX_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : oneLine;
}

/**
 * One line of at most MAX_TITLE_LENGTH, for any title: a tool's own (which can also start with IDE context)
 * or a prompt's. Undefined when nothing but IDE context is left.
 */
export function truncateTitle(text: string | undefined): string | undefined {
  const firstLine = (text === undefined ? undefined : stripLeadingContext(text))
    ?.split(/\r?\n/)
    .find((line) => line.trim() !== "")
    ?.replace(/\s+/g, " ")
    .trim();
  if (!firstLine) return undefined;
  return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine;
}

/**
 * Context an IDE puts in front of the prompt, e.g. `<ide_opened_file>…</ide_opened_file>` or
 * `<ide_selection>…</ide_selection>` from the Claude Code VS Code extension. Only tag names with `_` or `-`,
 * so a prompt that starts with ordinary HTML like `<b>` keeps it.
 */
const LEADING_CONTEXT_BLOCK = /^\s*<([a-z]+[_-][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/i;
/** The same tag with its end cut off, e.g. a title truncated mid-block: nothing usable follows. */
const UNCLOSED_CONTEXT_TAG = /^\s*<[a-z]+[_-][\w-]*\b[^>]*>/i;

function stripLeadingContext(text: string): string {
  let rest = text;
  for (let match = LEADING_CONTEXT_BLOCK.exec(rest); match; match = LEADING_CONTEXT_BLOCK.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return UNCLOSED_CONTEXT_TAG.test(rest) ? "" : rest;
}

/** A task name from a prompt. Slash commands like /clear or /compact aren't tasks. */
export function titleFromPrompt(prompt: string | undefined): string | undefined {
  const text = prompt === undefined ? undefined : stripLeadingContext(prompt);
  if (!text || text.trimStart().startsWith("/")) return undefined;
  return truncateTitle(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

/** A positive integer pid from a number or a numeric string (env vars are strings), else undefined. */
export function parsePid(value: unknown): number | undefined {
  const pid = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Validates an event arriving over HTTP. Returns null for anything malformed. */
export function parseAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null;
  const tool = nonEmptyString(value.tool, 64);
  const sessionId = nonEmptyString(value.sessionId, 256);
  const cwd = nonEmptyString(value.cwd, 4096);
  const timestamp = nonEmptyString(value.timestamp, 64);
  const status = value.status;
  if (!tool || !sessionId || !cwd || !timestamp) return null;
  if (typeof status !== "string" || !(AGENT_STATUSES as readonly string[]).includes(status)) return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;

  // Canonical ISO form, so the store can order events by plain string comparison.
  const event: AgentEvent = {
    tool,
    sessionId,
    cwd,
    status: status as AgentStatus,
    timestamp: new Date(time).toISOString(),
  };
  const message = truncateMessage(typeof value.message === "string" ? value.message : undefined);
  if (message) event.message = message;
  const title = truncateTitle(typeof value.title === "string" ? value.title : undefined);
  if (title) event.title = title;
  if (title && value.titleSource === "tool") event.titleSource = "tool";
  const pid = parsePid(value.pid);
  if (pid) event.pid = pid;
  if (typeof value.inputPending === "boolean") event.inputPending = value.inputPending;
  if (value.hidden === true) event.hidden = true;
  const host = nonEmptyString(value.host, 64);
  if (host) event.host = host;
  return event;
}
