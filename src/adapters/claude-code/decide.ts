import {
  DEFAULT_PLAN_FEEDBACK,
  type DecisionKind,
  PLAN_FEEDBACK_MAX,
  parseQuestions,
  previewFor,
  type Resolution,
} from "../../core/decision-types.js";
import { parseAgentId } from "../../core/types.js";
import type { AdapterDecide, DecideRequest } from "../types.js";
import { detectClaudeHost } from "./normalize.js";

/**
 * The VS Code extension and the Claude desktop app show their own Approve/Deny UI. The docs say that for a call that
 * reaches a permission-prompt tool or the Agent SDK's `canUseTool`, "the hooks run alongside your host, and whichever
 * decides first applies" (https://code.claude.com/docs/en/hooks, PermissionRequest). That these two hosts use that
 * path is inferred, not verified. The terminal CLI is not in this list: there the hook blocks Claude Code's prompt.
 */
export function isConcurrentHost(env: NodeJS.ProcessEnv): boolean {
  const host = detectClaudeHost(env);
  return host === "VS Code" || host === "Claude Desktop";
}

function withAgent(request: DecideRequest, record: Record<string, unknown>): DecideRequest {
  const agentId = parseAgentId(record.agent_id);
  if (!agentId) return request;
  const agentType = record.agent_type;
  return {
    ...request,
    agentId,
    ...(typeof agentType === "string" && agentType !== "" ? { agentType: agentType.slice(0, 64) } : {}),
  };
}

function parseClaudeDecide(raw: unknown, env: NodeJS.ProcessEnv): DecideRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId = record.session_id;
  const toolName = record.tool_name;
  const toolInput = record.tool_input;
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 256) return null;
  if (typeof toolName !== "string" || toolName === "" || toolName.length > 100) return null;
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return null;
  const input = toolInput as Record<string, unknown>;

  if (record.hook_event_name === "PermissionRequest") {
    // Questions are answered from PreToolUse; the permission hook would only duplicate them.
    if (toolName === "AskUserQuestion") return null;
    // The plan gets its own card (plan text, feedback box) rather than a generic "Allow ExitPlanMode?".
    const preview = previewFor(toolName, input);
    return withAgent(
      {
        kind: toolName === "ExitPlanMode" ? "plan" : "permission",
        sessionId,
        toolName,
        toolInput: input,
        ...(preview !== undefined ? { preview } : {}),
        ...(isConcurrentHost(env) ? { concurrent: true } : {}),
      },
      record,
    );
  }
  // Questions come from PreToolUse, which runs before the tool and so blocks the question UI in every host.
  if (record.hook_event_name === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = parseQuestions(input.questions);
    return questions
      ? withAgent({ kind: "question", sessionId, toolName, toolInput: input, questions }, record)
      : null;
  }
  return null;
}

function denyMessage(kind: DecisionKind, feedback: string | undefined): string {
  if (kind !== "plan") return "Denied from the AgentWatch dashboard.";
  const text = typeof feedback === "string" ? feedback.trim() : "";
  return text === "" ? DEFAULT_PLAN_FEEDBACK : text.slice(0, PLAN_FEEDBACK_MAX);
}

/** The JSON Claude Code expects on stdout; shapes are from https://code.claude.com/docs/en/hooks. */
export function buildClaudeDecideOutput(request: DecideRequest, resolution: Resolution): string | null {
  if (request.kind === "permission" || request.kind === "plan") {
    if (!("behavior" in resolution)) return null;
    const decision =
      resolution.behavior === "allow"
        ? // ExitPlanMode and friends need the input echoed back; for the rest it changes nothing.
          { behavior: "allow", updatedInput: request.toolInput }
        : { behavior: "deny", message: denyMessage(request.kind, resolution.message) };
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  }
  if (!("answers" in resolution)) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...request.toolInput,
        questions: request.toolInput.questions,
        answers: resolution.answers,
      },
    },
  });
}

export const claudeCodeDecide: AdapterDecide = {
  parse: parseClaudeDecide,
  buildOutput: buildClaudeDecideOutput,
};
