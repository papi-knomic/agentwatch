import type { Sound } from "../core/config.js";
import type { DecisionKind, DecisionQuestion, Resolution } from "../core/decision-types.js";
import type { AgentEvent, Session } from "../core/types.js";

export interface AdapterMeta {
  /** Stable id used in config, hook commands and events, e.g. "claude-code". */
  id: string;
  displayName: string;
  color: string;
  sound: Sound;
  docsUrl: string;
  /** Steps the user must take in the tool itself after installing, e.g. trusting new hooks. */
  afterInstall?: string[];
  /** The tool can have its permission prompts and questions answered from the dashboard (opt-in `decide` hooks). */
  remoteActions?: boolean;
}

export interface NormalizeContext {
  env: NodeJS.ProcessEnv;
  now: Date;
}

export interface InstallOptions {
  /** The user's home directory. Tests pass a temp dir so the real one is never touched. */
  homeDir: string;
  /** The exact command the tool should run, e.g. `node "C:/.../cli/index.js" hook --tool claude-code`. */
  hookCommand: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  /** `decide` hook command (see `hookCommand`), for tools with `meta.remoteActions`. */
  decideCommand?: string;
  /**
   * true: also install the opt-in `decide` hooks. false: remove them. Left out: don't touch them (an install
   * without the flag must not undo what an earlier one added).
   */
  remoteActions?: boolean;
}

export interface InstallResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
  /** Human-readable lines describing what was (or, on a dry run, would be) changed. */
  summary: string[];
  /** Follow-up steps the user has to take themselves, e.g. trusting new hooks in the tool. */
  notes?: string[];
}

/** What a tool's `decide` hook asks the dashboard, parsed from the hook payload (see `AdapterDecide`). */
export interface DecideRequest {
  kind: DecisionKind;
  sessionId: string;
  toolName: string;
  /** Raw tool input, kept only so `buildOutput` can echo it back where the tool needs that. Never sent on. */
  toolInput: Record<string, unknown>;
  /** Short display text (command, path, plan); set for permission and plan kinds. */
  preview?: string;
  questions?: DecisionQuestion[];
  /** Set when a subagent is asking (validated with `parseAgentId`). */
  agentId?: string;
  agentType?: string;
  /**
   * The host shows the same prompt itself and the hook runs alongside it, so it may wait the long concurrent
   * deadline and never needs a viewer. false/absent: the hook blocks the tool's own prompt (the "blocking" class).
   */
  concurrent?: boolean;
  /**
   * Blocking requests only: a stricter hold than the user's background-hold setting. `visibleOnly`: register only while
   * a dashboard tab is in front, and give the prompt back when none is. `maxHoldMs`: wait at most this long.
   */
  holdPolicy?: { visibleOnly?: boolean; maxHoldMs?: number };
}

/** A `decide` call that was deliberately left alone; recorded by the server for `agentwatch debug decisions`. */
export interface SkippedDecide {
  /** Short fixed identifier, e.g. "cli-permission-request-question". */
  reason: string;
  sessionId: string;
  toolName: string;
  concurrent: boolean;
}

/**
 * Tool-specific half of `agentwatch decide`. The generic flow (config checks, register, long-poll, deadlines) lives in
 * src/cli/decide.ts and never looks inside a payload; everything about one tool's hook format lives here.
 */
export interface AdapterDecide {
  /** The payload from stdin (already JSON-parsed, untrusted), or null when this event is not one we answer. */
  parse(payload: unknown, env: NodeJS.ProcessEnv): DecideRequest | null;
  /**
   * For payloads `parse` returned null for on purpose (e.g. another hook answers that prompt): what to record in the
   * debug log. Never carries prompt or question text.
   */
  skipped?(payload: unknown, env: NodeJS.ProcessEnv): SkippedDecide | null;
  /** The single stdout line the tool expects for this resolution, or null to stay silent. */
  buildOutput(request: DecideRequest, resolution: Resolution): string | null;
}

export interface Adapter {
  meta: AdapterMeta;
  /** Converts one raw hook payload into the shared format, or null if the event is irrelevant. */
  normalize(raw: unknown, ctx: NormalizeContext): AgentEvent | null;
  install(options: InstallOptions): Promise<InstallResult>;
  uninstall(options: InstallOptions): Promise<InstallResult>;
  /**
   * A link that opens this exact session in the tool's own UI. VS Code links wait until the project's
   * window has been brought to the front; standalone app links open directly.
   */
  sessionLink?(session: Session): string | undefined;
  /** Present on tools with `meta.remoteActions`: how their `decide` hook reads prompts and answers them. */
  decide?: AdapterDecide;
}

/** Identifies hook entries this project added, independent of where the CLI lives on disk. */
export function isOurHookCommand(command: unknown, toolId: string): boolean {
  return typeof command === "string" && new RegExp(`\\bhook --tool ${toolId}(\\s|$)`).test(command);
}

/** Identifies the opt-in `decide` hook entries (answering prompts from the dashboard). */
export function isOurDecideCommand(command: unknown, toolId: string): boolean {
  return typeof command === "string" && new RegExp(`\\bdecide --tool ${toolId}(\\s|$)`).test(command);
}
