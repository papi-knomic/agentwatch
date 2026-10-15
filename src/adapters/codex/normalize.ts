import { type AgentEvent, type AgentStatus, truncateMessage } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import type { NormalizeContext } from "../types.js";
import { codexMeta } from "./meta.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusFor(raw: Record<string, unknown>): { status: AgentStatus; message?: string } | null {
  switch (raw.hook_event_name) {
    case "SessionStart":
      return { status: "idle" };
    case "UserPromptSubmit":
    case "PostToolUse":
      return { status: "working" };
    case "PermissionRequest": {
      // Codex has no Notification event; an approval request is the "needs you" signal.
      const tool = str(raw.tool_name);
      return {
        status: "needs_input",
        message: tool ? `Needs permission to use ${tool}` : "Needs permission",
      };
    }
    case "Stop":
      return { status: "done" };
    case "Interrupt":
      return { status: "idle", message: "Interrupted" };
    case "SessionEnd":
      return { status: "ended" };
    default:
      return null;
  }
}

export function normalizeCodex(raw: unknown, ctx: NormalizeContext): AgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = str(record.session_id);
  const cwd = str(record.cwd);
  if (!sessionId || !cwd) return null;

  const mapped = statusFor(record);
  if (!mapped) return null;

  const event: AgentEvent = {
    tool: codexMeta.id,
    sessionId,
    cwd,
    status: mapped.status,
    timestamp: ctx.now.toISOString(),
  };
  const message = truncateMessage(mapped.message);
  if (message) event.message = message;
  const host = detectHost(ctx.env);
  if (host) event.host = host;
  return event;
}
