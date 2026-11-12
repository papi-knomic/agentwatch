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

/**
 * `agentwatch decide --tool claude-code`: the opt-in hook behind answering from the dashboard.
 *
 * Unlike `hook`, this one may print to stdout and may take a while, because that is the whole point: it holds a
 * permission prompt (or AskUserQuestion) open until the dashboard answers. Everything else is still the same
 * contract: always exit 0, never throw, and print nothing at all unless a decision was made. Silence makes Claude
 * Code carry on exactly as if the hook did not exist. It never waits unless a visible dashboard tab is open to
 * answer; while it waits, Claude Code's own prompt is held back (the hook runs first), so the server cancels the
 * decision as soon as no tab is visible and this hook then returns.
 */

/**
 * Claude Code cancels the hook at its `timeout` (120 s as installed); we give up a little earlier. Longer than the
 * server's decision lifetime (DECISION_TTL_MS, 100 s), so the server is what normally ends the wait.
 */
export const DECIDE_WAIT_DEADLINE_MS = 110_000;
const REGISTER_TIMEOUT_MS = 400;
const POLL_CHUNK_MS = 25_000;
/** Longer than a chunk, so the server's own timeout (204) is what ends a normal poll. */
const POLL_SLACK_MS = 5_000;
const STDIN_TIMEOUT_MS = 1_000;
/** After this many failed polls in a row the server is gone; stop holding the prompt. */
const MAX_POLL_FAILURES = 2;
const RETRY_PAUSE_MS = 500;

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
}

interface Parsed {
  kind: DecisionKind;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  questions?: DecisionQuestion[];
}

function parsePayload(text: string): Parsed | null {
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
      kind: toolName === "ExitPlanMode" ? "plan" : "permission",
      sessionId,
      toolName,
      toolInput: input,
    };
  }
  if (record.hook_event_name === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = parseQuestions(input.questions);
    return questions ? { kind: "question", sessionId, toolName, toolInput: input, questions } : null;
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

    const registered = await deps.fetch(`${base}/api/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: toolId,
        sessionId: parsed.sessionId,
        kind: parsed.kind,
        toolName: parsed.toolName,
        ...(parsed.kind !== "question"
          ? { preview: previewFor(parsed.toolName, parsed.toolInput) }
          : { questions: parsed.questions }),
      }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!registered.ok) return;
    const { id } = (await registered.json()) as { id?: unknown };
    // null: no dashboard is open (or the feature is off, or a cap was hit). Don't hold anything up.
    if (typeof id !== "string") return;

    const deadline = deps.now() + deps.deadlineMs;
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
