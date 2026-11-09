import { type AgentEvent, type AgentStatus, parsePid, truncateTitle } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import type { NormalizeContext } from "../types.js";
import { openCodeMeta } from "./meta.js";

/**
 * Input is the envelope our plugin (plugin.ts) sends: `{ v, event, directory, pid, at, rootSessionID?, title?,
 * afterError? }`. `event` is an OpenCode event cut down to the fields read here: `{ type, properties }` from
 * OpenCode 1.x (`v: 1`, fixtures/v1) or `{ type, data }` from 2.x (`v: 2`, fixtures/v2). Plugins installed
 * before 2.x support send no `v`; those are 1.x.
 */

/** OpenCode's placeholder until it names a session (isDefaultTitle in packages/opencode/src/session/session.ts). */
const DEFAULT_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Esc in OpenCode 1.x ends the turn with this "error"; it's the user's own doing, not a failure. */
const ABORTED = "MessageAbortedError";

/** A subagent's own busy/idle doesn't matter (its parent is busy throughout), but a prompt it raises does. */
const CHILD_EVENTS = new Set([
  "permission.asked",
  "permission.updated",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "form.created",
  "form.replied",
  "form.cancelled",
]);

interface Mapped {
  status: AgentStatus;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function permissionMessage(kind: string | undefined): string {
  return kind ? `Permission needed: ${kind}` : "Permission needed";
}

/** busy and retry mean the same in both majors; idle is left to each major's own "finished" event. */
function statusEvent(value: unknown): Mapped | null {
  const status = isRecord(value) ? value : {};
  if (status.type === "busy") return { status: "working" };
  if (status.type === "retry") {
    const reason = str(status.message);
    return { status: "working", message: reason ? `Retrying: ${reason}` : "Retrying" };
  }
  return null;
}

function statusForV1(
  type: string,
  props: Record<string, unknown>,
  afterError: string | undefined,
): Mapped | null {
  switch (type) {
    case "session.status":
      return statusEvent(props.status);
    case "session.idle":
      if (afterError === undefined) return { status: "done" };
      // The error event already set the status; a "done" now would hide it.
      return afterError === ABORTED ? { status: "idle", message: "Interrupted" } : null;
    case "session.error": {
      const error = isRecord(props.error) ? props.error : {};
      if (error.name === ABORTED) return null;
      const data = isRecord(error.data) ? error.data : {};
      return { status: "error", message: str(data.message) ?? str(error.name) ?? "Error" };
    }
    case "session.deleted":
      return { status: "ended" };
    case "permission.asked":
      return { status: "needs_input", message: permissionMessage(str(props.permission)) };
    case "permission.updated":
      // The pre-`permission.asked` name, still in the v1 SDK types; not seen from OpenCode 1.19.3.
      return { status: "needs_input", message: permissionMessage(str(props.type)) };
    case "permission.replied":
      // A rejection stops the turn; session.idle follows within milliseconds (captured).
      return { status: "working" };
    case "question.asked":
      return { status: "needs_input", message: "Has a question for you" };
    case "question.replied":
    case "question.rejected":
      return { status: "working" };
    default:
      return null;
  }
}

function statusForV2(type: string, data: Record<string, unknown>): Mapped | null {
  switch (type) {
    case "session.status":
      return statusEvent(data.status);
    case "session.execution.started":
      return { status: "working" };
    case "session.execution.succeeded":
      return { status: "done" };
    case "session.execution.failed": {
      const error = isRecord(data.error) ? data.error : {};
      return { status: "error", message: str(error.message) ?? str(error.type) ?? "Error" };
    }
    case "session.execution.interrupted":
      // "superseded": a new turn took over, which reports itself. "shutdown" is also how 2.2.6 ends a turn
      // after a rejected permission (captured), so it can't be ignored.
      if (data.reason === "superseded") return null;
      return { status: "idle", message: data.reason === "user" ? "Interrupted" : "Stopped" };
    case "session.deleted":
      return { status: "ended" };
    case "permission.asked":
      return { status: "needs_input", message: permissionMessage(str(data.action)) };
    case "permission.replied":
      return { status: "working" };
    case "form.created":
      // The question tool asks through a form.
      return { status: "needs_input", message: "Has a question for you" };
    case "form.replied":
    case "form.cancelled":
      return { status: "working" };
    default:
      return null;
  }
}

/** The session an event belongs to. 2.x forms name theirs inside the form. */
function sessionIdOf(v: 1 | 2, type: string, body: Record<string, unknown>): string | undefined {
  if (v === 1 && type === "session.deleted") return str(isRecord(body.info) ? body.info.id : undefined);
  if (v === 2 && type === "form.created") return str(isRecord(body.form) ? body.form.sessionID : undefined);
  return str(body.sessionID);
}

/** The plugin's own clock: hooks are separate processes and can reach the server out of order. */
function timestampOf(value: unknown, now: Date): string {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? now.toISOString() : new Date(time).toISOString();
}

export function normalizeOpenCode(raw: unknown, ctx: NormalizeContext): AgentEvent | null {
  if (!isRecord(raw) || !isRecord(raw.event)) return null;
  const v = raw.v === 2 ? 2 : 1;
  const type = str(raw.event.type);
  const body = v === 2 ? raw.event.data : raw.event.properties;
  const fields = isRecord(body) ? body : {};
  const ownId = type ? sessionIdOf(v, type, fields) : undefined;
  const cwd = str(raw.directory);
  // 2.x MCP elicitation forms belong to the "global" sentinel, not a session.
  if (!type || !ownId || ownId === "global" || !cwd) return null;

  const rootId = str(raw.rootSessionID);
  const isChild = rootId !== undefined && rootId !== ownId;
  if (isChild && !CHILD_EVENTS.has(type)) return null;

  const mapped = v === 2 ? statusForV2(type, fields) : statusForV1(type, fields, str(raw.afterError));
  if (!mapped) return null;

  const event: AgentEvent = {
    tool: openCodeMeta.id,
    sessionId: isChild ? rootId : ownId,
    cwd,
    status: mapped.status,
    timestamp: timestampOf(raw.at, ctx.now),
  };
  if (mapped.message) event.message = mapped.message;
  const rawTitle = str(raw.title);
  const title = rawTitle && !DEFAULT_TITLE.test(rawTitle) ? truncateTitle(rawTitle) : undefined;
  if (title) {
    event.title = title;
    event.titleSource = "tool";
  }
  // The OpenCode process: when it exits, the server drops its sessions (OpenCode sends no event on quit).
  const pid = parsePid(raw.pid) ?? parsePid(ctx.env.OPENCODE_PID);
  if (pid) event.pid = pid;
  const host = detectHost(ctx.env);
  if (host) event.host = host;
  return event;
}
