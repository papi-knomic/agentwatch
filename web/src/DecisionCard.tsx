import { agentCaption } from "./alerts";
import { projectName } from "./board";
import { DecisionPanel } from "./DecisionPanel";
import { StatusIcon } from "./parts";
import type { PendingDecision, Session } from "./useAgentStream";

/** "1:31": the mockup's countdown. */
function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One pending prompt: who is asking, how long the answer is held, and the answer controls. The card replaces the
 * session's row, so a waiting session is never listed twice.
 */
export function DecisionCard({
  decision,
  session,
  canAnswer,
  now,
}: {
  decision: PendingDecision;
  session: Session | undefined;
  canAnswer: boolean;
  now: number;
}) {
  const caption = agentCaption(decision);
  const left = Math.max(0, Math.round((Date.parse(decision.expiresAt) - now) / 1000));
  const title = session?.title?.trim();
  const project = session ? projectName(session.cwd) : undefined;
  return (
    <article className="dc" aria-label={`${title || project || "A session"}: ${decision.toolName} request`}>
      <header className="dc-h">
        <StatusIcon status="needs_input" decorative />
        <b className="ell">{title || project || "A session"}</b>
        {title && project && <span className="proj ell">{project}</span>}
        <span
          className="cd"
          title={
            decision.concurrent === true
              ? "The prompt stays open where it is also shown"
              : "Then Claude Code asks in the terminal instead"
          }
        >
          {countdown(left)} left
        </span>
      </header>
      <DecisionPanel decision={decision} canAnswer={canAnswer} host={session?.host} caption={caption} />
    </article>
  );
}
