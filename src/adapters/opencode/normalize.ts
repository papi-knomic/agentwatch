import { type AgentEvent, type AgentStatus, parsePid, truncateTitle } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import type { NormalizeContext } from "../types.js";
import { openCodeMeta } from "./meta.js";

/**
 * Input is the envelope our plugin (plugin.ts) sends: `{ event, directory, pid, at, rootSessionID?, title?,
 * afterError? }`, where `event` is an OpenCode bus event (fixtures/) cut down to the fields read here.
 */

/** OpenCode's placeholder until it names a session (isDefaultTitle in packages/opencode/src/session/session.ts). */
const DEFAULT_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Esc in OpenCode ends the turn with this "error"; it's the user's own doing, not a failure. */
const ABORTED = "MessageAbortedError";

/** A subagent's own busy/idle doesn't matter (its parent is busy throughout), but a prompt it raises does. */
const CHILD_EVENTS = new Set([
  "permission.asked",
  "permission.updated",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
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

function statusFor(
  type: string,
  props: Record<string, unknown>,
  afterError: string | undefined,
): Mapped | null {
  switch (type) {
    case "session.status": {
      const status = isRecord(props.status) ? props.status : {};
      if (status.type === "busy") return { status: "working" };
      if (status.type === "retry") {
        const reason = str(status.message);
        return { status: "working", message: reason ? `Retrying: ${reason}` : "Retrying" };
      }
      return null;
    }
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

/** The plugin's own clock: hooks are separate processes and can reach the server out of order. */
function timestampOf(value: unknown, now: Date): string {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? now.toISOString() : new Date(time).toISOString();
}

export function normalizeOpenCode(raw: unknown, ctx: NormalizeContext): AgentEvent | null {
  if (!isRecord(raw) || !isRecord(raw.event)) return null;
  const type = str(raw.event.type);
  const props = isRecord(raw.event.properties) ? raw.event.properties : {};
  const ownId =
    type === "session.deleted" ? str(isRecord(props.info) ? props.info.id : undefined) : str(props.sessionID);
  const cwd = str(raw.directory);
  if (!type || !ownId || !cwd) return null;

  const rootId = str(raw.rootSessionID);
  const isChild = rootId !== undefined && rootId !== ownId;
  if (isChild && !CHILD_EVENTS.has(type)) return null;

  const mapped = statusFor(type, props, str(raw.afterError));
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
