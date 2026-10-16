import { type AgentEvent, type AgentStatus, titleFromPrompt, truncateMessage } from "../../core/types.js";
import { detectHost } from "../shared/host.js";
import type { NormalizeContext } from "../types.js";
import { grokMeta } from "./meta.js";

interface Mapped {
  status: AgentStatus;
  message?: string;
  title?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Grok sends camelCase fields plus Claude-style snake_case duplicates; accept either. */
function field(raw: Record<string, unknown>, camel: string, snake: string): string | undefined {
  return str(raw[camel]) ?? str(raw[snake]);
}

/**
 * Captured payloads (Grok 1.0.34) carry `hookEventName: "session_start"` alongside
 * `hook_event_name: "SessionStart"`, and GROK_HOOK_EVENT is snake_case too. Normalize to PascalCase.
 */
export function grokEventName(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): string | undefined {
  const name = str(raw.hook_event_name) ?? str(raw.hookEventName) ?? str(env.GROK_HOOK_EVENT);
  // "stop" → "Stop", "session_start" → "SessionStart"; already-PascalCase names pass through unchanged.
  return name
    ?.split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function statusFor(event: string | undefined, raw: Record<string, unknown>): Mapped | null {
  switch (event) {
    case "SessionStart":
      return { status: "idle" };
    case "UserPromptSubmit": {
      const title = titleFromPrompt(str(raw.prompt));
      return title ? { status: "working", title } : { status: "working" };
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      return { status: "working" };
    case "Notification":
      // Unverified: never fired in our captures. Treated like Claude Code's notifications,
      // which Grok's hook system mirrors.
      return { status: "needs_input", message: field(raw, "message", "message") ?? "Needs your attention" };
    case "Stop":
      // Grok sends an extra Stop with reason "shutdown" after SessionEnd; it is not a finished turn.
      return raw.reason === "shutdown" ? null : { status: "done" };
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

  const mapped = statusFor(grokEventName(record, ctx.env), record);
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
  if (mapped.title) event.title = mapped.title;
  const host = detectHost(ctx.env);
  if (host) event.host = host;
  return event;
}
