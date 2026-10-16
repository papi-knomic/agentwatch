import { type AgentEvent, type AgentStatus, titleFromPrompt, truncateMessage } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import { toolActivity } from "../shared/tool-name.js";
import type { NormalizeContext } from "../types.js";
import { codexMeta } from "./meta.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function statusFor(
  raw: Record<string, unknown>,
): { status: AgentStatus; message?: string | undefined; title?: string | undefined } | null {
  switch (raw.hook_event_name) {
    case "SessionStart":
      return { status: "idle" };
    case "UserPromptSubmit":
      return { status: "working", title: titleFromPrompt(str(raw.prompt)) };
    case "PostToolUse":
      if (raw.tool_name === "request_user_input_async") {
        return { status: "needs_input", message: "Waiting for your answer" };
      }
      return { status: "working", message: toolActivity(str(raw.tool_name)) };
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
  if (record.hook_event_name === "UserPromptSubmit") {
    event.inputPending = false;
    // The desktop app starts a separate helper session for suggested replies. Match only its
    // observed marker, not general references to suggestions in a real user's task.
    if (
      /^\s*(?:\*\*)?This is an app-generated request for a suggested next user message\b/.test(
        str(record.prompt) ?? "",
      )
    ) {
      event.hidden = true;
      return event;
    }
  } else if (record.hook_event_name === "PostToolUse" && record.tool_name === "request_user_input_async") {
    event.inputPending = true;
  }
  const message = truncateMessage(mapped.message);
  if (message) event.message = message;
  if (mapped.title) event.title = mapped.title;
  // Observed in desktop sessions; prefer it over terminal variables inherited when launching the app.
  const host =
    ctx.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === "Codex Desktop" ? "Codex Desktop" : detectHost(ctx.env);
  if (host) event.host = host;
  return event;
}
