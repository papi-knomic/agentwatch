import { type AgentEvent, type AgentStatus, truncateMessage } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import type { NormalizeContext } from "../types.js";
import { grokMeta } from "./meta.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Grok documents camelCase fields; accept Claude-style snake_case too in case it sends those. */
function field(raw: Record<string, unknown>, camel: string, snake: string): string | undefined {
  return str(raw[camel]) ?? str(raw[snake]);
}

function statusFor(
  event: string | undefined,
  raw: Record<string, unknown>,
): { status: AgentStatus; message?: string } | null {
  switch (event) {
    case "SessionStart":
      return { status: "idle" };
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
      return { status: "working" };
    case "Notification":
      // Unverified: the docs don't describe this payload. Treated like Claude Code's notifications,
      // which Grok's hook system mirrors. Replace with a captured fixture when possible.
      return { status: "needs_input", message: field(raw, "message", "message") ?? "Needs your attention" };
    case "Stop":
      return { status: "done" };
    case "StopFailure":
      return { status: "error", message: field(raw, "error", "error") };
    case "SessionEnd":
      return { status: "ended" };
    default:
      return null;
  }
}

export function normalizeGrok(raw: unknown, ctx: NormalizeContext): AgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = field(record, "sessionId", "session_id") ?? str(ctx.env.GROK_SESSION_ID);
  const cwd = field(record, "cwd", "cwd") ?? field(record, "workspaceRoot", "workspace_root");
  if (!sessionId || !cwd) return null;

  const eventName = field(record, "hookEventName", "hook_event_name") ?? str(ctx.env.GROK_HOOK_EVENT);
  const mapped = statusFor(eventName, record);
  if (!mapped) return null;

  const event: AgentEvent = {
    tool: grokMeta.id,
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
