import { MAX_MESSAGE_LENGTH } from "./constants.js";

export const AGENT_STATUSES = ["idle", "working", "needs_input", "done", "error", "ended"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Statuses that can trigger a desktop notification. */
export const NOTIFIABLE_STATUSES = ["needs_input", "done", "error"] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

/** The contract between adapters and core. Every tool's raw hook payload is normalized into this. */
export interface AgentEvent {
  tool: string;
  sessionId: string;
  cwd: string;
  status: AgentStatus;
  message?: string;
  /** Where the agent runs, e.g. "VS Code", "Windows Terminal", "Claude Desktop". */
  host?: string;
  timestamp: string;
}

export interface Session {
  key: string;
  tool: string;
  sessionId: string;
  cwd: string;
  status: Exclude<AgentStatus, "ended">;
  message?: string;
  host?: string;
  startedAt: string;
  updatedAt: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
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
  const host = nonEmptyString(value.host, 64);
  if (host) event.host = host;
  return event;
}
