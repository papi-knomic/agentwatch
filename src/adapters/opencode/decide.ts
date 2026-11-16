import { PREVIEW_MAX, parseQuestions, type Resolution, truncate } from "../../core/decision-types.js";
import { parseAgentId } from "../../core/types.js";
import type { AdapterDecide, DecideRequest } from "../types.js";

/**
 * OpenCode has no blocking hook, so its plugin (plugin.ts) runs `agentwatch decide --tool opencode` beside the
 * prompt OpenCode shows itself and pipes in one cut-down JSON object:
 * `{ kind, sessionId, agentSessionId?, requestId, toolName, preview?, questions? }`. The plugin keeps the real
 * session and request ids and does the replying; this module only turns the payload into a `DecideRequest` and the
 * dashboard's answer into the one JSON line the plugin reads back. The AgentWatch token never reaches the plugin.
 *
 * Reply API (source-verified, not captured end to end except where the README says so):
 * - 1.x (tag v1.19.3): `POST /permission/:requestID/reply` `{ reply: "once" | "always" | "reject" }` and
 *   `POST /question/:requestID/reply` `{ answers: string[][] }` (one array of chosen labels per question, in order).
 *   packages/opencode/src/server/routes/instance/httpapi/groups/{permission,question}.ts
 * - 2.x (tag v2.2.6): `ctx.permission.reply({ sessionID, requestID, decision })`, permissions only: the reply route
 *   for forms (the question tool) is not verified. packages/cli/src/acp/permission.ts
 *
 * Concurrent host class: the TUI/app keeps its own prompt open, the first reply wins, and a late reply is a
 * not-found error the plugin ignores. Approve is always "once": a dashboard click never saves a standing rule.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOpenCodeDecide(raw: unknown): DecideRequest | null {
  if (!isRecord(raw)) return null;
  const { kind, sessionId, toolName, requestId } = raw;
  if (kind !== "permission" && kind !== "question") return null;
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 256) return null;
  if (typeof requestId !== "string" || requestId === "" || requestId.length > 256) return null;
  const name = typeof toolName === "string" && toolName !== "" ? truncate(toolName, 100) : kind;
  const agentId = parseAgentId(raw.agentSessionId);
  const base = {
    sessionId,
    toolName: name,
    toolInput: {},
    concurrent: true,
    ...(agentId ? { agentId } : {}),
  };

  if (kind === "permission") {
    const preview =
      typeof raw.preview === "string" && raw.preview !== "" ? truncate(raw.preview, PREVIEW_MAX) : undefined;
    return { kind, ...base, ...(preview !== undefined ? { preview } : {}) };
  }
  if (!Array.isArray(raw.questions)) return null;
  // OpenCode says `multiple`; the shared format says `multiSelect`.
  const questions = parseQuestions(
    raw.questions.map((q: unknown) => (isRecord(q) ? { ...q, multiSelect: q.multiple === true } : q)),
  );
  return questions ? { kind, ...base, questions } : null;
}

export function buildOpenCodeDecideOutput(request: DecideRequest, resolution: Resolution): string | null {
  if (request.kind === "permission") {
    if (!("behavior" in resolution)) return null;
    return JSON.stringify({ reply: resolution.behavior === "allow" ? "once" : "reject" });
  }
  if (request.kind !== "question" || !("answers" in resolution) || !request.questions) return null;
  const answers: string[][] = [];
  for (const question of request.questions) {
    const given = Object.hasOwn(resolution.answers, question.question)
      ? resolution.answers[question.question]
      : undefined;
    if (given === undefined) return null;
    // validateAnswers joined several picks with ", " (labels of multi-select questions contain no comma).
    answers.push(question.multiSelect ? given.split(", ") : [given]);
  }
  return JSON.stringify({ answers });
}

export const openCodeDecide: AdapterDecide = {
  parse: parseOpenCodeDecide,
  buildOutput: buildOpenCodeDecideOutput,
};
