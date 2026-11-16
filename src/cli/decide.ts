import { getAdapter, toolDefaults } from "../adapters/index.js";
import { type Config, readConfig } from "../core/config.js";
import { HOOK_STDIN_MAX_BYTES } from "../core/constants.js";
import type { Resolution } from "../core/decision-types.js";

/**
 * `agentwatch decide --tool <id>`: the opt-in hook behind answering from the dashboard. Which tools have one, and how
 * each reads its payload and words its answer, is the adapter's `decide` capability (src/adapters/types.ts); this
 * file is the generic part.
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
    const adapter = toolId === undefined ? undefined : getAdapter(toolId);
    if (!toolId || !adapter?.meta.remoteActions || !adapter.decide) return;
    // Grok also runs hooks from Claude Code's settings.json; it can't take our answer (it can only deny).
    if (deps.env.GROK_HOOK_EVENT || deps.env.GROK_SESSION_ID) return;

    const config = await deps.readConfig();
    if (config?.remoteActions !== true || config.tools[toolId]?.enabled === false) return;

    const decide = adapter.decide;
    let payload: unknown;
    try {
      payload = JSON.parse((await deps.readStdin()).replace(/^\uFEFF/, ""));
    } catch {
      return;
    }
    const parsed = decide.parse(payload, deps.env);
    if (!parsed) return;

    const base = `http://127.0.0.1:${config.port}`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${config.token}` };

    const concurrent = parsed.concurrent === true && parsed.kind !== "question";
    const body = JSON.stringify({
      tool: toolId,
      sessionId: parsed.sessionId,
      kind: parsed.kind,
      toolName: parsed.toolName,
      ...(concurrent ? { concurrent: true } : {}),
      ...(parsed.agentId ? { agentId: parsed.agentId, agentType: parsed.agentType } : {}),
      ...(parsed.kind !== "question" ? { preview: parsed.preview } : { questions: parsed.questions }),
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
        const output = decide.buildOutput(parsed, resolution);
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
