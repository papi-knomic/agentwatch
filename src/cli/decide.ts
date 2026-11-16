import { detectClaudeHost } from "../adapters/claude-code/normalize.js";
import { toolDefaults } from "../adapters/index.js";
import { type Config, readConfig } from "../core/config.js";
import { HOOK_STDIN_MAX_BYTES } from "../core/constants.js";
import {
  DEFAULT_PLAN_FEEDBACK,
  type DecisionKind,
  type DecisionQuestion,
  PLAN_FEEDBACK_MAX,
  parseQuestions,
  previewFor,
  type Resolution,
} from "../core/decision-types.js";
import { parseAgentId } from "../core/types.js";

/**
 * `agentwatch decide --tool claude-code`: the opt-in hook behind answering from the dashboard.
 *
 * Unlike `hook`, this one may print to stdout and may take a while, because that is the whole point: it holds a
 * permission prompt (or AskUserQuestion) open until the dashboard answers. Everything else is still the same
 * contract: always exit 0, never throw, and print nothing at all unless a decision was made. Silence makes Claude
 * Code carry on exactly as if the hook did not exist. It never waits unless a dashboard tab is connected to
 * answer; while it waits, Claude Code's own prompt is held back (the hook runs first), so the server cancels the
 * decision (briefly if the tabs are only in the background) and this hook then returns. Exception: permission and
 * plan prompts in VS Code / Claude Desktop, which have their own prompt alongside the hook (`concurrent`).
 */

/**
 * Claude Code cancels the hook at its `timeout` (120 s for AskUserQuestion as installed); we give up a little earlier. Longer than the
 * server's decision lifetime (DECISION_TTL_MS, 100 s), so the server is what normally ends the wait.
 */
export const DECIDE_WAIT_DEADLINE_MS = 110_000;
/**
 * Concurrent hosts (see `isConcurrentHost`): just above the server's CONCURRENT_TTL_MS (540 s) and below the 600 s
 * hook timeout the installer sets for PermissionRequest.
 */
export const DECIDE_CONCURRENT_DEADLINE_MS = 560_000;
const REGISTER_TIMEOUT_MS = 400;
const POLL_CHUNK_MS = 25_000;
/** Longer than a chunk, so the server's own timeout (204) is what ends a normal poll. */
const POLL_SLACK_MS = 5_000;
const STDIN_TIMEOUT_MS = 1_000;
/** After this many failed polls in a row the server is gone; stop holding the prompt. */
const MAX_POLL_FAILURES = 2;
const RETRY_PAUSE_MS = 500;
const UNKNOWN_SESSION_RETRY_MS = 300;

export interface DecideDeps {
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  readConfig: () => Promise<Config | null>;
  fetch: typeof fetch;
  /** Writes one line to stdout and resolves once it has been flushed. */
  print: (line: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadlineMs: number;
  /** For concurrent decisions; defaults to DECIDE_CONCURRENT_DEADLINE_MS. */
  concurrentDeadlineMs?: number;
}

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

interface Parsed {
  kind: DecisionKind;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  questions?: DecisionQuestion[];
  /** Set when a subagent is asking (Claude Code includes agent_id/agent_type only inside subagents). */
  agentId?: string;
  agentType?: string;
}

function withAgent(parsed: Parsed, record: Record<string, unknown>): Parsed {
  const agentId = parseAgentId(record.agent_id);
  if (!agentId) return parsed;
  const agentType = record.agent_type;
  return {
    ...parsed,
    agentId,
    ...(typeof agentType === "string" && agentType !== "" ? { agentType: agentType.slice(0, 64) } : {}),
  };
}

function parsePayload(text: string): Parsed | null {
  const parsed = parseBasics(text);
  if (!parsed) return null;
  return withAgent(parsed.value, parsed.record);
}

function parseBasics(text: string): { value: Parsed; record: Record<string, unknown> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
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
    return {
      value: {
        kind: toolName === "ExitPlanMode" ? "plan" : "permission",
        sessionId,
        toolName,
        toolInput: input,
      },
      record,
    };
  }
  if (record.hook_event_name === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = parseQuestions(input.questions);
    return questions
      ? { value: { kind: "question", sessionId, toolName, toolInput: input, questions }, record }
      : null;
  }
  return null;
}

/** The JSON Claude Code expects on stdout; shapes are from https://code.claude.com/docs/en/hooks. */
export function buildOutput(parsed: Parsed, resolution: Resolution): string | null {
  if (parsed.kind === "permission" || parsed.kind === "plan") {
    if (!("behavior" in resolution)) return null;
    const decision =
      resolution.behavior === "allow"
        ? // ExitPlanMode and friends need the input echoed back; for the rest it changes nothing.
          { behavior: "allow", updatedInput: parsed.toolInput }
        : { behavior: "deny", message: denyMessage(parsed.kind, resolution.message) };
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  }
  if (!("answers" in resolution)) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...parsed.toolInput,
        questions: parsed.toolInput.questions,
        answers: resolution.answers,
      },
    },
  });
}

function denyMessage(kind: DecisionKind, feedback: string | undefined): string {
  if (kind !== "plan") return "Denied from the AgentWatch dashboard.";
  const text = typeof feedback === "string" ? feedback.trim() : "";
  return text === "" ? DEFAULT_PLAN_FEEDBACK : text.slice(0, PLAN_FEEDBACK_MAX);
}

function isResolution(value: unknown): value is Resolution {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.behavior === "allow" || record.behavior === "deny") return true;
  const answers = record.answers;
  return (
    typeof answers === "object" &&
    answers !== null &&
    Object.values(answers).every((a) => typeof a === "string")
  );
}

export async function runDecide(toolId: string | undefined, deps: DecideDeps): Promise<void> {
  try {
    if (toolId !== "claude-code") return;
    // Grok also runs hooks from Claude Code's settings.json; it can't take our answer (it can only deny).
    if (deps.env.GROK_HOOK_EVENT || deps.env.GROK_SESSION_ID) return;

    const config = await deps.readConfig();
    if (config?.remoteActions !== true || config.tools[toolId]?.enabled === false) return;

    const parsed = parsePayload(await deps.readStdin());
    if (!parsed) return;

    const base = `http://127.0.0.1:${config.port}`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${config.token}` };

    // Questions come from PreToolUse, which runs before the tool and so blocks the question UI in every host.
    const concurrent = parsed.kind !== "question" && isConcurrentHost(deps.env);
    const body = JSON.stringify({
      tool: toolId,
      sessionId: parsed.sessionId,
      kind: parsed.kind,
      toolName: parsed.toolName,
      ...(concurrent ? { concurrent: true } : {}),
      ...(parsed.agentId ? { agentId: parsed.agentId, agentType: parsed.agentType } : {}),
      ...(parsed.kind !== "question"
        ? { preview: previewFor(parsed.toolName, parsed.toolInput) }
        : { questions: parsed.questions }),
    });
    const register = async (): Promise<{ id?: unknown; reason?: unknown } | null> => {
      const response = await deps.fetch(`${base}/api/decisions`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      return response.ok ? ((await response.json()) as { id?: unknown; reason?: unknown }) : null;
    };
    let registered = await register();
    // The regular hook that tells the server about this session runs in parallel and may not have landed yet.
    if (registered?.id == null && registered?.reason === "unknown_session") {
      await deps.sleep(UNKNOWN_SESSION_RETRY_MS);
      registered = await register();
    }
    const id = registered?.id;
    // null: no dashboard is open (or the feature is off, or a cap was hit). Don't hold anything up.
    if (typeof id !== "string") return;

    const deadline =
      deps.now() +
      (concurrent ? (deps.concurrentDeadlineMs ?? DECIDE_CONCURRENT_DEADLINE_MS) : deps.deadlineMs);
    let failures = 0;
    while (deps.now() < deadline) {
      const chunk = Math.min(POLL_CHUNK_MS, deadline - deps.now());
      if (chunk <= 0) break;
      try {
        const res = await deps.fetch(`${base}/api/decisions/${encodeURIComponent(id)}/wait?ms=${chunk}`, {
          headers,
          signal: AbortSignal.timeout(chunk + POLL_SLACK_MS),
        });
        failures = 0;
        if (res.status === 204) continue;
        if (res.status !== 200) return; // expired, cancelled (answered locally) or unknown
        const resolution: unknown = await res.json();
        if (!isResolution(resolution)) return;
        const output = buildOutput(parsed, resolution);
        if (output) await deps.print(output);
        return;
      } catch {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) return;
        await deps.sleep(RETRY_PAUSE_MS);
      }
    }
  } catch {
    // Never the agent's problem: silence means "carry on as usual".
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > HOOK_STDIN_MAX_BYTES) {
        data = "";
        finish();
      }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export function defaultDecideDeps(): DecideDeps {
  return {
    readStdin,
    env: process.env,
    readConfig: () => readConfig(toolDefaults()),
    fetch,
    print: (line) => new Promise((resolve) => process.stdout.write(`${line}\n`, () => resolve())),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    deadlineMs: DECIDE_WAIT_DEADLINE_MS,
  };
}
