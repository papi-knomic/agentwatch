import { join } from "node:path";
import { APP_NAME } from "../../core/constants.js";
import { addClaudeStyleHooks, removeClaudeStyleHooks } from "../shared/claude-style-hooks.js";
import { updateJsonFile } from "../shared/json-config.js";
import { type InstallOptions, type InstallResult, isOurHookCommand } from "../types.js";
import { grokMeta } from "./meta.js";

/** Each event maps to a status in normalize.ts. Keep the two lists in sync. */
export const GROK_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/**
 * Grok loads every ~/.grok/hooks/*.json, so we keep our hooks in a file of our own instead of
 * editing anyone else's. That file needs no backup, and uninstall deletes it.
 */
export function grokHooksPath(options: Pick<InstallOptions, "homeDir">): string {
  return join(options.homeDir, ".grok", "hooks", `${APP_NAME}.json`);
}

const isOurs = (command: unknown) => isOurHookCommand(command, grokMeta.id);

export async function installGrok(options: InstallOptions): Promise<InstallResult> {
  const configPath = grokHooksPath(options);
  const summary: string[] = [];
  // Grok's default hook timeout is 5s; ours finishes in well under a second either way.
  const handler = { type: "command", command: options.hookCommand, timeout: 5 };
  const result = await updateJsonFile(
    configPath,
    (data) => addClaudeStyleHooks(data, GROK_HOOK_EVENTS, () => handler, isOurs, configPath, summary),
    { dryRun: options.dryRun, backup: false },
  );
  return { configPath, summary, ...result };
}

export async function uninstallGrok(options: InstallOptions): Promise<InstallResult> {
  const configPath = grokHooksPath(options);
  const summary: string[] = [];
  const result = await updateJsonFile(
    configPath,
    (data) => removeClaudeStyleHooks(data, isOurs, configPath, summary),
    { dryRun: options.dryRun, backup: false, deleteIfEmpty: true },
  );
  return { configPath, summary, ...result };
}
