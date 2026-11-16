import type { Session } from "../../core/types.js";
import { createDesktopSessionResolver } from "./desktop-sessions.js";

const resolveDesktopId = createDesktopSessionResolver();

/**
 * VS Code sessions use the extension's documented URI handler (see README). It focuses the session's tab if
 * one is open, otherwise resumes it in a new tab. Only for extension sessions: a CLI session in VS Code's
 * terminal would be resumed in a second process alongside the one already running.
 *
 * Claude Desktop sessions use the app's undocumented `claude://code/continue` route, which needs the app's own
 * `local_` id. If we can't find it there is no link: `session=last` could open the wrong chat, so the
 * dashboard reports it can't open and notifications fall back to the dashboard.
 */
export function claudeCodeSessionLink(
  session: Session,
  resolve: (cliSessionId: string) => string | undefined = resolveDesktopId,
): string | undefined {
  if (session.host === "Claude Desktop") {
    const id = resolve(session.sessionId);
    return id ? `claude://code/continue?session=${encodeURIComponent(id)}&source=agentwatch` : undefined;
  }
  if (session.host !== "VS Code") return undefined;
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(session.sessionId)}`;
}
