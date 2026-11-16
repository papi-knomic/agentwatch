import type { CSSProperties } from "react";
import { agentCaption } from "./alerts";
import { projectName } from "./board";
import { DecisionPanel } from "./DecisionPanel";
import type { PendingDecision, Session, ToolInfo } from "./useAgentStream";

/**
 * One pending prompt: who is asking, how long the answer is held, and the answer controls. The card replaces the
 * session's row, so a waiting session is never listed twice.
 */
export function DecisionCard({
  decision,
  session,
  tool,
  canAnswer,
  now,
  bare = false,
}: {
  decision: PendingDecision;
  session: Session | undefined;
  tool: ToolInfo | undefined;
  canAnswer: boolean;
  now: number;
  /** Inside the side panel the session is already named, so the card drops its own header. */
  bare?: boolean;
}) {
  const caption = agentCaption(decision);
  const left = Math.max(0, Math.round((Date.parse(decision.expiresAt) - now) / 1000));
  const title = session?.title?.trim();
  const project = session ? projectName(session.cwd) : undefined;
  return (
    <article
      className={bare ? "dc bare" : "dc"}
      style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}
      aria-label={`${title || project || "A session"}: ${decision.toolName} request`}
    >
      <header className="dc-h">
        {!bare && (
          <>
            <span className="dc-who">
              <b className="dc-name ell">{title || project || "A session"}</b>
              {title && project && <span className="dc-proj ell">{project}</span>}
            </span>
            {session && (
              <span className="tt">
                <i />
                {tool?.label ?? session.tool}
              </span>
            )}
          </>
        )}
        {caption && <span className="badge sub">{caption}</span>}
        <span
          className="dc-cd"
          title={
            decision.concurrent === true
              ? "The prompt stays open where it is also shown"
              : "Then Claude Code asks in the terminal instead"
          }
        >
          {left}s left
        </span>
      </header>
      <DecisionPanel decision={decision} canAnswer={canAnswer} host={session?.host} />
    </article>
  );
}
