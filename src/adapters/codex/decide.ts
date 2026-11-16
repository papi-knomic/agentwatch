import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * approval prompt back. Unlike Claude Code it ignores the background-hold setting: it registers only while a tab is
 * visible and waits at most 30 s (`holdPolicy`), because it may sit in front of Codex's auto reviewer (see
 * `codexAutoReviewerOn`). (Whether the desktop app runs the hook alongside its prompt is unverified.)
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

/**
 * Codex runs PermissionRequest hooks BEFORE its auto reviewer (codex-rs/core/src/tools/approvals.rs), so a hook that
 * waits for the dashboard would delay every auto-reviewed call. The hook payload has no reviewer field, so the one
 * signal we have is `approvals_reviewer` in config.toml (enum ApprovalsReviewer, codex-rs/protocol/src/config_types.rs).
 * The desktop app may keep its setting elsewhere; the hold policy below limits the cost when we can't tell.
 */
const REVIEWER_CONFIG_MAX_BYTES = 256 * 1024;
const AUTO_REVIEWERS = new Set(["auto_review", "guardian_subagent"]);
/** Nobody is expected at the dashboard for Codex: keep any wait short and only while a tab is in front. */
export const CODEX_MAX_HOLD_MS = 30_000;

function tomlString(raw: string): string | null {
  const match = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(raw);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Tolerant line reader: top-level keys, plus the `[profiles.<active>]` table. Not a TOML parser. */
export function readApprovalsReviewer(toml: string): string | null {
  let table = "";
  let topReviewer: string | null = null;
  let profile: string | null = null;
  const byProfile = new Map<string, string>();
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header?.[1] !== undefined && !line.trim().startsWith("[[")) {
      table = header[1].replace(/["']/g, "");
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv?.[1] || kv[2] === undefined) continue;
    const value = tomlString(kv[2]);
    if (value === null) continue;
    if (table === "") {
      if (kv[1] === "approvals_reviewer") topReviewer = value;
      else if (kv[1] === "profile") profile = value;
    } else if (kv[1] === "approvals_reviewer" && table.startsWith("profiles.")) {
      byProfile.set(table.slice("profiles.".length), value);
    }
  }
  return (profile !== null ? byProfile.get(profile) : undefined) ?? topReviewer;
}

/** True when Codex's auto reviewer is configured. Any problem reading the file means "unknown", i.e. false. */
export function codexAutoReviewerOn(env: NodeJS.ProcessEnv): boolean {
  try {
    const file = join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
    if (statSync(file).size > REVIEWER_CONFIG_MAX_BYTES) return false;
    const reviewer = readApprovalsReviewer(readFileSync(file, "utf8"));
    return reviewer !== null && AUTO_REVIEWERS.has(reviewer.toLowerCase());
  } catch {
    return false;
  }
}

function parseCodexDecide(raw: unknown, env: NodeJS.ProcessEnv): DecideRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.hook_event_name !== "PermissionRequest") return null;
  if (codexAutoReviewerOn(env)) return null;
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
    holdPolicy: { visibleOnly: true, maxHoldMs: CODEX_MAX_HOLD_MS },
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
