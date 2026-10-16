import {
  type AgentEvent,
  type AgentStatus,
  parsePid,
  titleFromPrompt,
  truncateMessage,
  truncateTitle,
} from "../../core/types.js";
import { detectTerminalHost } from "../shared/host.js";
import { toolActivity } from "../shared/tool-name.js";
import type { NormalizeContext } from "../types.js";
import { claudeCodeMeta } from "./meta.js";
import { readAiTitle } from "./title.js";

/** Notification types that mean "a human has to act before Claude can continue". */
const NEEDS_INPUT_NOTIFICATIONS = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function detectClaudeHost(env: NodeJS.ProcessEnv): string | undefined {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint === "claude-vscode") return "VS Code";
  if (entrypoint === "cli") return detectTerminalHost(env) ?? "Terminal";
  return detectTerminalHost(env) ?? entrypoint;
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
      return { status: "working", message: toolActivity(str(raw.tool_name)) };
    case "PostToolUseFailure":
      return { status: "working", message: toolActivity(str(raw.tool_name), true) };
    case "Notification": {
      const type = str(raw.notification_type);
      const message = str(raw.message);
      if (type !== undefined) {
        return NEEDS_INPUT_NOTIFICATIONS.has(type) ? { status: "needs_input", message: message ?? "" } : null;
      }
      // Older Claude Code versions send no notification_type; only permission prompts need action.
      return message && /permission/i.test(message) ? { status: "needs_input", message } : null;
    }
    case "Stop":
      return { status: "done" };
    case "StopFailure": {
      const parts = [str(raw.error), str(raw.error_details)].filter(Boolean);
      return { status: "error", message: parts.join(": ") };
    }
    case "SessionEnd":
      return { status: "ended" };
    default:
      return null;
  }
}

export function normalizeClaudeCode(raw: unknown, ctx: NormalizeContext): AgentEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  // Grok also runs hooks from Claude Code's settings.json; its sessions are reported by the grok adapter.
  if (ctx.env.GROK_HOOK_EVENT || ctx.env.GROK_SESSION_ID) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = str(record.session_id);
  const cwd = str(record.cwd);
  if (!sessionId || !cwd) return null;

  const mapped = statusFor(record);
  if (!mapped) return null;

  const event: AgentEvent = {
    tool: claudeCodeMeta.id,
    sessionId,
    cwd,
    status: mapped.status,
    timestamp: ctx.now.toISOString(),
  };
  if (record.hook_event_name === "UserPromptSubmit") event.inputPending = false;
  const message = truncateMessage(mapped.message);
  if (message) event.message = message;
  // A name the user set (session_title: SessionStart only), else the generated one VS Code shows, else the
  // prompt as a stand-in until Claude Code has generated a name.
  const toolTitle =
    truncateTitle(str(record.session_title)) ??
    (mapped.status === "ended" ? undefined : readAiTitle(str(record.transcript_path)));
  if (toolTitle) {
    event.title = toolTitle;
    event.titleSource = "tool";
  } else if (mapped.title) {
    event.title = mapped.title;
  }
  const pid = parsePid(ctx.env.CLAUDE_PID);
  if (pid) event.pid = pid;
  const host = detectClaudeHost(ctx.env);
  if (host) event.host = host;
  return event;
}
