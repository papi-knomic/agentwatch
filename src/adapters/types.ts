import type { Sound } from "../core/config.js";
import type { AgentEvent } from "../core/types.js";

export interface AdapterMeta {
  /** Stable id used in config, hook commands and events, e.g. "claude-code". */
  id: string;
  displayName: string;
  color: string;
  sound: Sound;
  docsUrl: string;
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
}

export interface InstallResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
  /** Human-readable lines describing what was (or, on a dry run, would be) changed. */
  summary: string[];
}

export interface Adapter {
  meta: AdapterMeta;
  /** Converts one raw hook payload into the shared format, or null if the event is irrelevant. */
  normalize(raw: unknown, ctx: NormalizeContext): AgentEvent | null;
  install(options: InstallOptions): Promise<InstallResult>;
  uninstall(options: InstallOptions): Promise<InstallResult>;
}

/** Identifies hook entries this project added, independent of where the CLI lives on disk. */
export function isOurHookCommand(command: unknown, toolId: string): boolean {
  return typeof command === "string" && new RegExp(`\\bhook --tool ${toolId}(\\s|$)`).test(command);
}
