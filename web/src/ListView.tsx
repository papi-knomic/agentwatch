import { type CSSProperties, useState } from "react";
import {
  isStalled,
  needsApprovalHint,
  type Project,
  projectName,
  statusDuration,
  statusSince,
} from "./board";
import { DecisionCard } from "./DecisionCard";
import { HoldInfo } from "./DecisionPanel";
import { DismissButton, OpenButton, StatusIcon, ToolTag } from "./parts";
import type { PendingDecision, Session, ToolInfo } from "./useAgentStream";
import { anyBlocking, openTargetFor } from "./view";

/** What every row and card needs from the dashboard. */
export interface ViewContext {
  toolById: Map<string, ToolInfo>;
  /** A tag that says the same thing on every row is noise: shown only with two or more agents. */
  showTool: boolean;
  now: number;
  /** Viewed from a paired phone: no actions that open apps on the PC. */
  remote: boolean;
  canAnswer: boolean;
}

/** What the row says next to its title. Finished and idle rows need nothing beyond their time. */
export function detailFor(session: Session): string | undefined {
  switch (session.status) {
    case "needs_input":
      return session.message ?? "Waiting for your input";
    case "error":
      return session.message ?? "Stopped with an error";
    case "working":
      return session.message;
    default:
      return undefined;
  }
}

export function sessionName(session: Session, showProject: boolean): string {
  const title = session.title?.trim();
  return title ? title : showProject ? projectName(session.cwd) : "Untitled session";
}

export function StalledBadge() {
  return (
    <span className="badge warn" title="No events for 10 minutes or more">
      No activity
    </span>
  );
}

export function SessionRow({
  session,
  ctx,
  showProject,
}: {
  session: Session;
  ctx: ViewContext;
  showProject: boolean;
}) {
  const tool = ctx.toolById.get(session.tool);
  const title = session.title?.trim() ? session.title : undefined;
  const name = sessionName(session, showProject);
  const detail = detailFor(session);
  const openTarget = openTargetFor(session.host);
  const hot = session.status === "needs_input" || session.status === "error";

  return (
    <li
      className={`ra st-${session.status}`}
      style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}
    >
      <StatusIcon status={session.status} />
      <span className="t">
        <span className={title ? "ell" : "ell untitled"} title={title ?? session.cwd}>
          {name}
        </span>
        {showProject && title && (
          <small className="ell" title={session.cwd}>
            {projectName(session.cwd)}
          </small>
        )}
        {isStalled(session) && <StalledBadge />}
      </span>
      <span className="m">
        {detail && <span className="ell">{detail}</span>}
        {needsApprovalHint(session) && <em>Approved it? This updates when the command finishes.</em>}
      </span>
      <span className="ra-meta">
        {ctx.showTool ? <ToolTag tool={tool} fallback={session.tool} /> : <span />}
        <span className="host ell" title={session.host}>
          {session.host}
        </span>
        <span
          className={`time${hot ? ` hot${session.status === "error" ? " e" : ""}` : ""}`}
          title={new Date(statusSince(session)).toLocaleString()}
        >
          {statusDuration(session, ctx.now)}
        </span>
      </span>
      <span className="acts">
        {openTarget && !ctx.remote && <OpenButton sessionKey={session.key} target={openTarget} />}
        <DismissButton sessionKey={session.key} name={name} />
      </span>
    </li>
  );
}

const INBOX_CAP = 6;

/**
 * Everything that is waiting on you, always on top and not affected by filters or collapsed folders: nothing that
 * holds an agent up can be missed. Prompts that can be answered here are cards; the rest are one-line rows.
 */
function Inbox({
  decisions,
  waiting,
  sessionByKey,
  ctx,
}: {
  decisions: PendingDecision[];
  /** Needs-you sessions with no card (a terminal prompt after the hold, a Codex question, an error). */
  waiting: Session[];
  sessionByKey: Map<string, Session>;
  ctx: ViewContext;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? decisions : decisions.slice(0, INBOX_CAP);
  return (
    <section className="inbox" aria-labelledby="inbox-title" aria-live="polite">
      <h2 id="inbox-title" className="sec-h">
        Needs you <span className="n">{decisions.length + waiting.length}</span>
      </h2>
      {/* Concurrent prompts are also shown in their host, so holding a prompt back does not apply to them. */}
      {anyBlocking(decisions) && (
        <p className="inbox-note">
          Held prompts go back to the terminal if you don't answer in time.
          <HoldInfo hold={decisions.find((d) => d.concurrent !== true)?.backgroundHold ?? "full"} />
        </p>
      )}
      {decisions.length > 0 && (
        <div className="ib-grid">
          {shown.map((decision) => {
            const session = sessionByKey.get(decision.sessionKey);
            return (
              <DecisionCard
                key={decision.id}
                decision={decision}
                session={session}
                tool={session ? ctx.toolById.get(session.tool) : undefined}
                canAnswer={ctx.canAnswer}
                now={ctx.now}
              />
            );
          })}
        </div>
      )}
      {decisions.length > INBOX_CAP && (
        <button type="button" className="btn sm more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${decisions.length} prompts`}
        </button>
      )}
      {waiting.length > 0 && (
        <ul className="ra-list ib-rows">
          {waiting.map((session) => (
            <SessionRow key={session.key} session={session} ctx={ctx} showProject />
          ))}
        </ul>
      )}
    </section>
  );
}

const SUMMARY_PARTS = ["needs_input", "error", "working", "idle", "done"] as const;
const SUMMARY_LABEL = {
  needs_input: "waiting",
  error: "stopped",
  working: "working",
  idle: "idle",
  done: "done",
} as const;

/** Stays visible when the folder is collapsed, so it still says what's going on inside. */
function ProjectSummary({ sessions }: { sessions: Session[] }) {
  return (
    <span className="sum">
      {SUMMARY_PARTS.map((status) => {
        const n = sessions.filter((s) => s.status === status).length;
        return n > 0 ? (
          <span key={status} title={`${n} ${SUMMARY_LABEL[status]}`}>
            <StatusIcon status={status} decorative />
            {n} {SUMMARY_LABEL[status]}
          </span>
        ) : null;
      })}
    </span>
  );
}

function ProjectGroup({
  project,
  collapsed,
  onToggle,
  ctx,
}: {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  ctx: ViewContext;
}) {
  const rowsId = `rows-${project.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <section className={collapsed ? "grp c" : "grp"} aria-label={project.name}>
      <button
        type="button"
        className="gh"
        aria-expanded={!collapsed}
        aria-controls={rowsId}
        onClick={onToggle}
      >
        <svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <b className="gh-name ell">{project.name}</b>
        <span className="path ell" title={project.cwd}>
          {project.cwd}
        </span>
        <ProjectSummary sessions={project.sessions} />
      </button>
      {!collapsed && (
        <ul className="ra-list" id={rowsId}>
          {project.sessions.map((session) => (
            <SessionRow key={session.key} session={session} ctx={ctx} showProject={false} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ListView({
  decisions,
  waiting,
  sessionByKey,
  projects,
  collapsed,
  onToggleProject,
  ctx,
}: {
  decisions: PendingDecision[];
  waiting: Session[];
  sessionByKey: Map<string, Session>;
  projects: Project[];
  collapsed: Set<string>;
  onToggleProject: (key: string) => void;
  ctx: ViewContext;
}) {
  return (
    <>
      {decisions.length + waiting.length > 0 && (
        <Inbox decisions={decisions} waiting={waiting} sessionByKey={sessionByKey} ctx={ctx} />
      )}
      {projects.map((project) => (
        <ProjectGroup
          key={project.key}
          project={project}
          collapsed={collapsed.has(project.key)}
          onToggle={() => onToggleProject(project.key)}
          ctx={ctx}
        />
      ))}
    </>
  );
}
