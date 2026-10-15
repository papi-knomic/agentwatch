import { homedir } from "node:os";
import { adapters, getAdapter, toolDefaults } from "../adapters/index.js";
import type { Adapter } from "../adapters/types.js";
import { ensureConfig } from "../core/config.js";

/**
 * `node "<cli>" hook --tool <id>` with a forward-slash path: runs unchanged under cmd, PowerShell,
 * Git Bash and POSIX shells, which is what agents use to run hook commands.
 */
export function buildHookCommand(cliPath: string, toolId: string): string {
  return `node "${cliPath.replace(/\\/g, "/")}" hook --tool ${toolId}`;
}

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
}
