/**
 * `node "<cli>" hook --tool <id>` with a forward-slash path: runs unchanged under cmd, PowerShell,
 * Git Bash and POSIX shells, which is what agents use to run hook commands.
 */
export function buildHookCommand(cliPath: string, toolId: string): string {
  return `node "${cliPath.replace(/\\/g, "/")}" hook --tool ${toolId}`;
}
