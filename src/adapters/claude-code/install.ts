import { join } from "node:path";
import { addClaudeStyleHooks, removeClaudeStyleHooks } from "../shared/claude-style-hooks.js";
import { updateJsonFile } from "../shared/json-config.js";
import { type InstallOptions, type InstallResult, isOurHookCommand } from "../types.js";
import { claudeCodeMeta } from "./meta.js";

/** Each event maps to a status in normalize.ts. Keep the two lists in sync. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

export function claudeSettingsPath(options: Pick<InstallOptions, "homeDir" | "env">): string {
  const configDir = options.env.CLAUDE_CONFIG_DIR;
  return join(
    configDir && configDir.length > 0 ? configDir : join(options.homeDir, ".claude"),
    "settings.json",
  );
}

const isOurs = (command: unknown) => isOurHookCommand(command, claudeCodeMeta.id);

export async function installClaudeCode(options: InstallOptions): Promise<InstallResult> {
  const configPath = claudeSettingsPath(options);
  const summary: string[] = [];
  // async: Claude Code runs the hook in the background, so it can never delay a turn.
  const handler = { type: "command", command: options.hookCommand, async: true, timeout: 10 };
  const result = await updateJsonFile(
    configPath,
    (settings) =>
      addClaudeStyleHooks(settings, CLAUDE_HOOK_EVENTS, () => handler, isOurs, configPath, summary),
    { dryRun: options.dryRun },
  );
  return { configPath, summary, ...result };
}

export async function uninstallClaudeCode(options: InstallOptions): Promise<InstallResult> {
  const configPath = claudeSettingsPath(options);
  const summary: string[] = [];
  const result = await updateJsonFile(
    configPath,
    (settings) => removeClaudeStyleHooks(settings, isOurs, configPath, summary),
    { dryRun: options.dryRun },
  );
  return { configPath, summary, ...result };
}
