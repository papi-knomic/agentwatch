/** Best-effort guess at which terminal a CLI agent is running in, from well-known env vars. */
export function detectTerminalHost(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TERM_PROGRAM === "vscode") return "VS Code terminal";
  if (env.WT_SESSION) return "Windows Terminal";
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  return undefined;
}
