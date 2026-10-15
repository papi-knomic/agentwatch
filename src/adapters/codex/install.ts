import { join } from "node:path";
import { addClaudeStyleHooks, removeClaudeStyleHooks } from "../shared/claude-style-hooks.js";
import { updateJsonFile } from "../shared/json-config.js";
import { type InstallOptions, type InstallResult, isOurHookCommand } from "../types.js";
import { codexMeta } from "./meta.js";

/** Each event maps to a status in normalize.ts. Keep the two lists in sync. */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;

/** Codex caps these at 3s and always runs SessionEnd synchronously. */
const SHORT_TIMEOUT_EVENTS = new Set(["SessionEnd", "Interrupt"]);

const TRUST_NOTE =
  "Codex skips new hooks until you trust them: run /hooks in Codex (CLI or extension) and approve them.";

export function codexHooksPath(options: Pick<InstallOptions, "homeDir" | "env">): string {
  const codexHome = options.env.CODEX_HOME;
  return join(codexHome && codexHome.length > 0 ? codexHome : join(options.homeDir, ".codex"), "hooks.json");
}

const isOurs = (command: unknown) => isOurHookCommand(command, codexMeta.id);

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
    (data) => addClaudeStyleHooks(data, CODEX_HOOK_EVENTS, handlerFor, isOurs, configPath, summary),
    { dryRun: options.dryRun },
  );
  return { configPath, summary, ...result, ...(result.changed ? { notes: [TRUST_NOTE] } : {}) };
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
