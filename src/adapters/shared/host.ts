/** Best-effort guess at which terminal a CLI agent is running in, from well-known env vars. */
export function detectTerminalHost(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TERM_PROGRAM === "vscode") return "VS Code terminal";
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  return undefined;
}

/**
 * Terminal first, then VS Code: processes started by a VS Code extension (not its terminal) inherit
 * VSCODE_PID but not TERM_PROGRAM. Heuristic; used for tools that don't report their own front end.
 */
export function detectHost(env: NodeJS.ProcessEnv): string | undefined {
  return detectTerminalHost(env) ?? (env.VSCODE_PID ? "VS Code" : undefined);
}
