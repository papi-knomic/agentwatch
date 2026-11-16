import { PREVIEW_MAX, previewFor, type Resolution, truncate } from "../../core/decision-types.js";
import { parseAgentId } from "../../core/types.js";
import type { AdapterDecide, DecideRequest } from "../types.js";

/**
 * Codex `PermissionRequest` only. Input schema:
 * https://raw.githubusercontent.com/openai/codex/main/codex-rs/hooks/schema/generated/permission-request.command.input.schema.json
 * Docs: https://learn.chatgpt.com/docs/hooks. Codex has no hook for questions or plans, so there is no `question`
 * or `plan` kind here.
 *
 * Blocking host class: no host is known to show its own prompt next to the hook, so a pending hook holds Codex's
 * approval prompt back and follows the user's background-hold setting like the Claude Code terminal does. (Whether
 * the desktop app runs the hook alongside its prompt is unverified; treating it as blocking is the safe side.)
 */

/** Codex's shell tool puts the command in `tool_input.command`, as a string or (unverified) an argv array. */
function previewForCodex(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  const { command } = toolInput;
  if (typeof command === "string" && command !== "") return truncate(command, PREVIEW_MAX);
  if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string")) {
    return truncate(command.join(" "), PREVIEW_MAX);
  }
  return previewFor(toolName, toolInput);
}

function parseCodexDecide(raw: unknown): DecideRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.hook_event_name !== "PermissionRequest") return null;
  const sessionId = record.session_id;
  const toolName = record.tool_name;
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 256) return null;
  if (typeof toolName !== "string" || toolName === "" || toolName.length > 100) return null;
  // `tool_input` is schema-free in Codex; anything that is not an object just has no preview.
  const toolInput =
    typeof record.tool_input === "object" && record.tool_input !== null && !Array.isArray(record.tool_input)
      ? (record.tool_input as Record<string, unknown>)
      : {};
  const preview = previewForCodex(toolName, toolInput);
  const agentId = parseAgentId(record.agent_id);
  const agentType = record.agent_type;
  return {
    kind: "permission",
    sessionId,
    toolName,
    toolInput,
    ...(preview !== undefined ? { preview } : {}),
    ...(agentId
      ? {
          agentId,
          ...(typeof agentType === "string" && agentType !== "" ? { agentType: agentType.slice(0, 64) } : {}),
        }
      : {}),
  };
}

/**
 * Same hook JSON as Claude Code, but only `behavior` (+ `message` on deny): the docs say `updatedInput`,
 * `updatedPermissions` and `interrupt` fail closed in Codex, so they are never sent. Silence (null) means "show the
 * normal approval prompt".
 */
export function buildCodexDecideOutput(request: DecideRequest, resolution: Resolution): string | null {
  if (request.kind !== "permission" || !("behavior" in resolution)) return null;
  const decision =
    resolution.behavior === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied from the AgentWatch dashboard." };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

export const codexDecide: AdapterDecide = {
  parse: parseCodexDecide,
  buildOutput: buildCodexDecideOutput,
};
