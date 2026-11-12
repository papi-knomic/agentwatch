import { join } from "node:path";
import { addClaudeStyleHooks, removeClaudeStyleHooks } from "../shared/claude-style-hooks.js";
import { updateJsonFile } from "../shared/json-config.js";
import { type InstallOptions, type InstallResult, isOurDecideCommand, isOurHookCommand } from "../types.js";
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

/**
 * The opt-in hooks that let the dashboard answer a permission prompt or an AskUserQuestion. They run `decide`, which
 * waits for the answer, so they are not async and get a longer timeout (seconds) than the plain hooks.
 */
export const CLAUDE_DECIDE_HOOKS = {
  PermissionRequest: "*",
  PreToolUse: "AskUserQuestion",
} as const;
export const DECIDE_TIMEOUT_SECONDS = 120;

const isHookCommand = (command: unknown) => isOurHookCommand(command, claudeCodeMeta.id);
const isDecideCommand = (command: unknown) => isOurDecideCommand(command, claudeCodeMeta.id);
const isOurs = (command: unknown) => isHookCommand(command) || isDecideCommand(command);

export async function installClaudeCode(options: InstallOptions): Promise<InstallResult> {
  const configPath = claudeSettingsPath(options);
  const summary: string[] = [];
  // async: Claude Code runs the hook in the background, so it can never delay a turn.
  const handler = { type: "command", command: options.hookCommand, async: true, timeout: 10 };
  const result = await updateJsonFile(
    configPath,
    (settings) => {
      addClaudeStyleHooks(settings, CLAUDE_HOOK_EVENTS, () => handler, isHookCommand, configPath, summary);
      if (options.remoteActions === true) {
        if (!options.decideCommand) throw new Error("remoteActions needs a decideCommand.");
        const decide = {
          type: "command",
          command: options.decideCommand,
          timeout: DECIDE_TIMEOUT_SECONDS,
        };
        const events = Object.keys(CLAUDE_DECIDE_HOOKS);
        addClaudeStyleHooks(
          settings,
          events,
          () => decide,
          isDecideCommand,
          configPath,
          summary,
          (event) => CLAUDE_DECIDE_HOOKS[event as keyof typeof CLAUDE_DECIDE_HOOKS],
        );
      } else if (options.remoteActions === false) {
        removeClaudeStyleHooks(settings, isDecideCommand, configPath, summary);
      }
      return settings;
    },
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
