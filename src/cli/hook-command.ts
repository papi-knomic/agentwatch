/**
 * `node "<cli>" hook --tool <id>` with a forward-slash path: runs unchanged under cmd, PowerShell,
 * Git Bash and POSIX shells, which is what agents use to run hook commands.
 */
export function buildHookCommand(cliPath: string, toolId: string): string {
  return `node "${cliPath.replace(/\\/g, "/")}" hook --tool ${toolId}`;
}

/** Like the hook command, for the opt-in `decide` hooks that answer prompts from the dashboard. */
export function buildDecideCommand(cliPath: string, toolId: string): string {
  return `node "${cliPath.replace(/\\/g, "/")}" decide --tool ${toolId}`;
}
