import type { Sound } from "../core/config.js";
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
}

/** Identifies hook entries this project added, independent of where the CLI lives on disk. */
export function isOurHookCommand(command: unknown, toolId: string): boolean {
  return typeof command === "string" && new RegExp(`\\bhook --tool ${toolId}(\\s|$)`).test(command);
}

/** Identifies the opt-in `decide` hook entries (answering prompts from the dashboard). */
export function isOurDecideCommand(command: unknown, toolId: string): boolean {
  return typeof command === "string" && new RegExp(`\\bdecide --tool ${toolId}(\\s|$)`).test(command);
}
