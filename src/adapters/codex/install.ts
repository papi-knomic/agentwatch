import { join } from "node:path";
import { addClaudeStyleHooks, removeClaudeStyleHooks } from "../shared/claude-style-hooks.js";
import { updateJsonFile } from "../shared/json-config.js";
import { type InstallOptions, type InstallResult, isOurDecideCommand, isOurHookCommand } from "../types.js";
import { codexMeta } from "./meta.js";

/** Each event maps to a status in normalize.ts. Keep the two lists in sync. */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;

/** Codex caps these at 3s and always runs SessionEnd synchronously. */
const SHORT_TIMEOUT_EVENTS = new Set(["SessionEnd", "Interrupt"]);

export function codexHooksPath(options: Pick<InstallOptions, "homeDir" | "env">): string {
  const codexHome = options.env.CODEX_HOME;
  return join(codexHome && codexHome.length > 0 ? codexHome : join(options.homeDir, ".codex"), "hooks.json");
}

/**
 * The opt-in hook that lets the dashboard answer a permission prompt. It is a SEPARATE entry from the async notify
 * hook on the same event: it must be synchronous (async hooks can't decide), and 600 s is Codex's documented default
 * timeout (https://learn.chatgpt.com/docs/hooks). Only PermissionRequest: Codex has no hook for questions or plans.
 */
export const CODEX_DECIDE_EVENTS = ["PermissionRequest"] as const;
export const CODEX_DECIDE_TIMEOUT_SECONDS = 600;

const isHookCommand = (command: unknown) => isOurHookCommand(command, codexMeta.id);
const isDecideCommand = (command: unknown) => isOurDecideCommand(command, codexMeta.id);
const isOurs = (command: unknown) => isHookCommand(command) || isDecideCommand(command);

export async function installCodex(options: InstallOptions): Promise<InstallResult> {
  const configPath = codexHooksPath(options);
  const summary: string[] = [];
  const handlerFor = (event: string) => ({
    type: "command",
    command: options.hookCommand,
    // async: Codex runs the hook in the background and never waits on it (ignored for SessionEnd).
    async: true,
    timeout: SHORT_TIMEOUT_EVENTS.has(event) ? 3 : 10,
  });
  const result = await updateJsonFile(
    configPath,
    (data) => {
      addClaudeStyleHooks(data, CODEX_HOOK_EVENTS, handlerFor, isHookCommand, configPath, summary);
      if (options.remoteActions === true) {
        if (!options.decideCommand) throw new Error("remoteActions needs a decideCommand.");
        const command = options.decideCommand;
        addClaudeStyleHooks(
          data,
          CODEX_DECIDE_EVENTS,
          // No `async`: the hook has to be waited for to be able to answer.
          () => ({ type: "command", command, timeout: CODEX_DECIDE_TIMEOUT_SECONDS }),
          isDecideCommand,
          configPath,
          summary,
        );
      } else if (options.remoteActions === false) {
        removeClaudeStyleHooks(data, isDecideCommand, configPath, summary);
      }
      return data;
    },
    { dryRun: options.dryRun },
  );
  return {
    configPath,
    summary,
    ...result,
    ...(result.changed ? { notes: codexMeta.afterInstall ?? [] } : {}),
  };
}

export async function uninstallCodex(options: InstallOptions): Promise<InstallResult> {
  const configPath = codexHooksPath(options);
  const summary: string[] = [];
  const result = await updateJsonFile(
    configPath,
    (data) => removeClaudeStyleHooks(data, isOurs, configPath, summary),
    { dryRun: options.dryRun },
  );
  return { configPath, summary, ...result };
}
