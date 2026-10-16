import type { Session } from "../../core/types.js";

/** The desktop app's documented local-chat deep link (see README). */
export function codexSessionLink(session: Session): string | undefined {
  if (session.host !== "Codex Desktop") return undefined;
  if (["", "new", ".", ".."].includes(session.sessionId)) return undefined;
  return `codex://threads/${encodeURIComponent(session.sessionId)}`;
}
