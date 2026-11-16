import { rm } from "node:fs/promises";
import { join } from "node:path";
import { APP_NAME } from "../../core/constants.js";
import { readTextIfExists, writeFileAtomic } from "../../core/fs.js";
import type { InstallOptions, InstallResult } from "../types.js";
import { openCodeMeta } from "./meta.js";
import { DECIDE_ENABLED_LINE, PLUGIN_MARKER, pluginSource } from "./plugin.js";

/**
 * OpenCode loads every `{plugin,plugins}/*.{js,ts}` in its config folder, which is `$XDG_CONFIG_HOME/opencode`
 * or `~/.config/opencode` on every OS, Windows included (xdg-basedir). So the plugin is a file of our own:
 * nothing of the user's is edited, no backup is needed, and uninstall deletes it.
 */
export function openCodePluginPath(options: Pick<InstallOptions, "homeDir" | "env">): string {
  const configHome = options.env.XDG_CONFIG_HOME || join(options.homeDir, ".config");
  return join(configHome, "opencode", "plugins", `${APP_NAME}.js`);
}

const isOurs = (text: string) => text.startsWith(PLUGIN_MARKER);

export async function installOpenCode(options: InstallOptions): Promise<InstallResult> {
  const configPath = openCodePluginPath(options);
  const existing = await readTextIfExists(configPath);
  if (existing !== null && !isOurs(existing)) {
    throw new Error(
      `${configPath} exists but wasn't written by ${APP_NAME}. It was left untouched; rename it and try again.`,
    );
  }
  // An install without the flag keeps whatever an earlier one chose (like the other tools' decide hooks).
  const decide = options.remoteActions ?? existing?.includes(DECIDE_ENABLED_LINE) === true;
  const source = pluginSource(options.hookCommand, {
    decide,
    ...(options.decideCommand ? { decideCommand: options.decideCommand } : {}),
  });
  if (existing === source) return { configPath, changed: false, summary: [] };
  if (!options.dryRun) await writeFileAtomic(configPath, source);
  return {
    configPath,
    changed: true,
    summary: [
      `${existing === null ? "Add" : "Update"} the ${openCodeMeta.displayName} plugin ${configPath}${decide ? " (with answering from the dashboard)" : ""}`,
    ],
    notes: openCodeMeta.afterInstall ?? [],
  };
}

export async function uninstallOpenCode(options: InstallOptions): Promise<InstallResult> {
  const configPath = openCodePluginPath(options);
  const existing = await readTextIfExists(configPath);
  // Someone else's file at our path is theirs to keep.
  if (existing === null || !isOurs(existing)) return { configPath, changed: false, summary: [] };
  if (!options.dryRun) await rm(configPath, { force: true });
  return {
    configPath,
    changed: true,
    summary: [`Remove the ${openCodeMeta.displayName} plugin ${configPath}`],
  };
}
