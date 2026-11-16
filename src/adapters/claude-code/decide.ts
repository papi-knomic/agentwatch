import {
  DEFAULT_PLAN_FEEDBACK,
  type DecisionKind,
  PLAN_FEEDBACK_MAX,
  parseQuestions,
  previewFor,
  type Resolution,
} from "../../core/decision-types.js";
import { parseAgentId } from "../../core/types.js";
import type { AdapterDecide, DecideRequest, SkippedDecide } from "../types.js";
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
    if (toolName === "AskUserQuestion") {
      // Terminal CLI: the PreToolUse hook already blocks the question UI, so a card from here would be a duplicate.
      if (!isConcurrentHost(env)) return null;
      // VS Code / Claude Desktop route the question through their permission UI, so this hook runs beside it; the
      // docs require `updatedInput` (with the answers) on allow for AskUserQuestion. Unverified live.
      const questions = parseQuestions(input.questions);
      return questions
        ? withAgent(
            { kind: "question", sessionId, toolName, toolInput: input, questions, concurrent: true },
            record,
          )
        : null;
    }
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
  // Terminal: questions come from PreToolUse, which runs before the tool and so blocks the question UI. Concurrent
  // hosts must not block it (their UI shows at once); they are answered from PermissionRequest above.
  if (record.hook_event_name === "PreToolUse" && toolName === "AskUserQuestion") {
    if (isConcurrentHost(env)) return null;
    const questions = parseQuestions(input.questions);
    return questions
      ? withAgent({ kind: "question", sessionId, toolName, toolInput: input, questions }, record)
      : null;
  }
  return null;
}

/** Which AskUserQuestion calls we leave alone, for the debug log. */
function skippedClaudeDecide(raw: unknown, env: NodeJS.ProcessEnv): SkippedDecide | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { session_id: sessionId, tool_name: toolName } = record;
  if (toolName !== "AskUserQuestion" || typeof sessionId !== "string") return null;
  if (sessionId === "" || sessionId.length > 256) return null;
  const concurrent = isConcurrentHost(env);
  if (record.hook_event_name === "PreToolUse" && concurrent) {
    return { reason: "question-handled-by-permission-request", sessionId, toolName, concurrent };
  }
  if (record.hook_event_name === "PermissionRequest" && !concurrent) {
    return { reason: "cli-permission-request-question", sessionId, toolName, concurrent };
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
  const answered = {
    ...request.toolInput,
    questions: request.toolInput.questions,
    answers: resolution.answers,
  };
  // Concurrent hosts get the question through PermissionRequest, where allow carries the answers in updatedInput.
  if (request.concurrent === true) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: answered },
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: answered },
  });
}

export const claudeCodeDecide: AdapterDecide = {
  parse: parseClaudeDecide,
  skipped: skippedClaudeDecide,
  buildOutput: buildClaudeDecideOutput,
};
