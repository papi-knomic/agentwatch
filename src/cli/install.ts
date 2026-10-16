import { homedir } from "node:os";
import { adapters, getAdapter, toolDefaults } from "../adapters/index.js";
import type { Adapter } from "../adapters/types.js";
import { ensureConfig } from "../core/config.js";
import { APP_NAME } from "../core/constants.js";
import { migrateLegacyHome } from "../core/paths.js";
import { registerWindowsAppId, unregisterWindowsAppId, WINDOWS_APP_KEY } from "../notify/windows-identity.js";
import { buildHookCommand } from "./hook-command.js";
import { openUrl } from "./open.js";
import { assertStableInstall, autostart, startInBackground } from "./service.js";

export { buildHookCommand };

function resolveTargets(tool: string | undefined): Adapter[] {
  if (tool === "all") return [...adapters];
  const adapter = tool ? getAdapter(tool) : undefined;
  if (!adapter) {
    const ids = adapters.map((a) => a.meta.id).join(", ");
    throw new Error(`Specify --tool <id>. Supported: ${ids}, all`);
  }
  return [adapter];
}

export async function installCommand(options: {
  tool: string | undefined;
  uninstall: boolean;
  dryRun: boolean;
  home: string | undefined;
  cliPath: string;
}): Promise<void> {
  const targets = resolveTargets(options.tool);
  if (!options.uninstall && !options.home) assertStableInstall(options.cliPath);
  if (!options.dryRun && !options.home) {
    const moved = migrateLegacyHome();
    if (moved) console.log(`Moved ${moved} to the new location.`);
  }
  // The hook needs the token from the config, so make sure it exists before agents start calling it.
  if (!options.uninstall && !options.dryRun) await ensureConfig(toolDefaults());

  // An explicit --home means "act on this directory only", so ignore tool-specific config env vars.
  const env = options.home ? {} : process.env;
  const homeDir = options.home ?? homedir();

  for (const adapter of targets) {
    const installOptions = {
      homeDir,
      env,
      dryRun: options.dryRun,
      hookCommand: buildHookCommand(options.cliPath, adapter.meta.id),
    };
    const result = options.uninstall
      ? await adapter.uninstall(installOptions)
      : await adapter.install(installOptions);

    const verb = options.dryRun ? "Would change" : "Changed";
    console.log(`${adapter.meta.displayName}: ${result.configPath}`);
    if (!result.changed) {
      console.log(options.uninstall ? "  Nothing to remove." : "  Already installed, nothing to change.");
      continue;
    }
    console.log(`  ${verb}:`);
    for (const line of result.summary) console.log(`    - ${line}`);
    if (result.backupPath) console.log(`  Backup: ${result.backupPath}`);
    for (const note of result.notes ?? []) console.log(`  Next: ${note}`);
  }

  // The notification name is shared by every tool, so only `uninstall --tool all` removes it.
  // An explicit --home is a sandbox (tests, trying things out): leave the registry alone then.
  const identityApplies = !options.uninstall || options.tool === "all";
  if (process.platform === "win32" && !options.home && identityApplies) {
    const identity = options.uninstall
      ? await unregisterWindowsAppId({ dryRun: options.dryRun })
      : await registerWindowsAppId({ dryRun: options.dryRun });
    console.log(`Windows notifications: ${WINDOWS_APP_KEY}`);
    if (!identity.changed) {
      console.log(options.uninstall ? "  Nothing to remove." : "  Already registered, nothing to change.");
    } else {
      console.log(`  ${options.dryRun ? "Would change" : "Changed"}:`);
      for (const line of identity.summary) console.log(`    - ${line}`);
      if (!options.dryRun && !options.uninstall) {
        console.log("  Next: restart the server so notifications use the new name.");
      }
    }
  }

  // Start-at-login belongs to the whole app, so only a full uninstall removes it. `setup` adds it.
  if (options.uninstall && options.tool === "all" && !options.home) {
    const entry = autostart(options.cliPath);
    const result = await entry.uninstall(options.dryRun);
    console.log(`Start at login: ${result.location}`);
    console.log(
      result.changed ? `  ${options.dryRun ? "Would remove" : "Removed"}.` : "  Nothing to remove.",
    );
  }
}

/** One command from zero to working: hooks for every tool, start at login, server running, dashboard open. */
export async function setupCommand(options: {
  cliPath: string;
  autostart: boolean;
  open: boolean;
}): Promise<void> {
  assertStableInstall(options.cliPath);
  await installCommand({
    tool: "all",
    uninstall: false,
    dryRun: false,
    home: undefined,
    cliPath: options.cliPath,
  });

  if (options.autostart) {
    const entry = autostart(options.cliPath);
    const result = await entry.install(false);
    console.log(`Start at login: ${result.changed ? "added" : "already set up"} (${result.location})`);
  }

  const { url, alreadyRunning } = await startInBackground(options.cliPath);
  console.log(
    alreadyRunning
      ? `Dashboard already running at ${url}. Restart it to pick up changes: ${APP_NAME} stop, then ${APP_NAME} start --background`
      : `Dashboard running at ${url}`,
  );
  console.log(
    "\nStart a new agent session (Claude Code, Codex or Grok) and it will show up on the dashboard.",
  );
  if (options.open) openUrl(url);
}
