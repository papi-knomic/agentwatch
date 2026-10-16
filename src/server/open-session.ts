import type { Session } from "../core/types.js";
import { vscodeUrl } from "./notifications.js";

/**
 * VS Code gives a URI to whichever window has focus, so the session link must wait until the project's
 * window is in front. If this is too short, the link reaches the previously focused window and opens a
 * blank conversation there. 1s felt laggy; 0.7s is a guess at the margin, not measured. Raise it if
 * blank conversations show up.
 */
export const SESSION_LINK_DELAY_MS = 700;

/** Standalone app links open directly; VS Code session links need the project window focused first. */
export function sessionOpenUrls(session: Session, sessionLink: string | undefined): string[] {
  if (sessionLink && !sessionLink.startsWith("vscode:")) return [sessionLink];
  if (!session.host?.startsWith("VS Code")) return [];
  return sessionLink ? [vscodeUrl(session.cwd), sessionLink] : [vscodeUrl(session.cwd)];
}

/** Returns a function that opens a session and reports whether there was anything to open. */
export function createSessionOpener(options: {
  linkFor: (session: Session) => string | undefined;
  openUrl: (url: string) => void;
  delayMs?: number;
}): (session: Session) => boolean {
  const delayMs = options.delayMs ?? SESSION_LINK_DELAY_MS;
  return (session) => {
    const [first, ...rest] = sessionOpenUrls(session, options.linkFor(session));
    if (!first) return false;
    options.openUrl(first);
    for (const [index, url] of rest.entries()) {
      setTimeout(() => options.openUrl(url), delayMs * (index + 1));
    }
    return true;
  };
}
