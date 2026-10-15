import type { Session } from "../../core/types.js";

/**
 * The extension's documented URI handler (see README). It focuses the session's tab if one is open,
 * otherwise resumes it in a new tab. Only for extension sessions: a CLI session in VS Code's terminal
 * would be resumed in a second process alongside the one already running.
 */
export function claudeCodeSessionLink(session: Session): string | undefined {
  if (session.host !== "VS Code") return undefined;
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(session.sessionId)}`;
}
