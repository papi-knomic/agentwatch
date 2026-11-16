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
import { anyBlocking, openTargetFor, shortenPath } from "./view";

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

/** The time column keeps the real wording ("Waiting 7m"); rows that need you get the status colour. */
export function TimeCell({ session, now }: { session: Session; now: number }) {
  const hot = session.status === "needs_input" || session.status === "error";
  return (
    <span
      className={`time${hot ? ` hot${session.status === "error" ? " e" : ""}` : ""}`}
      title={new Date(statusSince(session)).toLocaleString()}
    >
      {statusDuration(session, now)}
    </span>
  );
}

function Actions({ session, ctx, name }: { session: Session; ctx: ViewContext; name: string }) {
  const openTarget = openTargetFor(session.host);
  return (
    <div className="acts">
      {openTarget && !ctx.remote && <OpenButton sessionKey={session.key} target={openTarget} />}
      <DismissButton sessionKey={session.key} name={name} />
    </div>
  );
}

/** A row in a project folder. */
export function SessionRow({ session, ctx }: { session: Session; ctx: ViewContext }) {
  const tool = ctx.toolById.get(session.tool);
  const title = session.title?.trim() ? session.title : undefined;
  // Inside a folder the project is already the heading.
  const name = sessionName(session, false);
  const detail = detailFor(session);

  return (
    <li
      className={`ra st-${session.status}`}
      style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}
    >
      <StatusIcon status={session.status} />
      <div className="t">
        <span className={title ? "ell" : "ell untitled"} title={title ?? session.cwd}>
          {name}
        </span>
        {isStalled(session) && <StalledBadge />}
      </div>
      <div className="m ell" title={detail}>
        {detail}
      </div>
      <div className="ra-meta">
        {ctx.showTool ? <ToolTag tool={tool} fallback={session.tool} /> : <span />}
        <span className="host" title={session.host}>
          {session.host}
        </span>
        <TimeCell session={session} now={ctx.now} />
      </div>
      <Actions session={session} ctx={ctx} name={name} />
    </li>
  );
}

/** A session that needs you but has no card here (a terminal prompt, a question we can't answer, an error). */
function InboxRow({ session, ctx }: { session: Session; ctx: ViewContext }) {
  const tool = ctx.toolById.get(session.tool);
  const title = session.title?.trim() ? session.title : undefined;
  const name = sessionName(session, true);
  const detail = detailFor(session);
  return (
    <div
      className={`ib-row st-${session.status}`}
      style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}
    >
      <StatusIcon status={session.status} />
      <div className="t ell" title={title ? session.cwd : undefined}>
        <span className={title ? undefined : "untitled"}>{name}</span>
        {title && <small>{projectName(session.cwd)}</small>}
      </div>
      <div className="m ell" title={detail}>
        {detail}
        {needsApprovalHint(session) && (
          <span className="hint">Approved it? This updates when the command finishes.</span>
        )}
      </div>
      <div className="meta">
        {ctx.showTool && <ToolTag tool={tool} fallback={session.tool} />}
        <span className="host" title={session.host}>
          {session.host}
        </span>
        <TimeCell session={session} now={ctx.now} />
      </div>
      <Actions session={session} ctx={ctx} name={name} />
    </div>
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
        <span>Needs you</span>
        <span className="n">{decisions.length + waiting.length}</span>
        <span className="sp" />
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
          {shown.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              session={sessionByKey.get(decision.sessionKey)}
              canAnswer={ctx.canAnswer}
              now={ctx.now}
            />
          ))}
        </div>
      )}
      {decisions.length > INBOX_CAP && (
        <button type="button" className="btn sm more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${decisions.length} prompts`}
        </button>
      )}
      {waiting.map((session) => (
        <InboxRow key={session.key} session={session} ctx={ctx} />
      ))}
    </section>
  );
}

const SUMMARY_PARTS = ["working", "idle", "done"] as const;

/** Stays visible when the folder is collapsed, so it still says what's going on inside. */
function ProjectSummary({ sessions, above }: { sessions: Session[]; above: number }) {
  return (
    <span className="sum">
      {above > 0 && (
        <span style={{ color: "var(--need)" }} title={`${above} waiting for you, listed under "Needs you"`}>
          <StatusIcon status="needs_input" decorative />
          {above} above
        </span>
      )}
      {SUMMARY_PARTS.map((status) => {
        const n = sessions.filter((s) => s.status === status).length;
        return n > 0 ? (
          <span key={status} title={`${n} ${status}`}>
            <StatusIcon status={status} decorative />
            {n}
          </span>
        ) : null;
      })}
    </span>
  );
}

function ProjectGroup({
  project,
  above,
  collapsed,
  onToggle,
  ctx,
}: {
  project: Project;
  /** Sessions of this folder that need you (listed under "Needs you", not here). */
  above: number;
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
        <svg
          className="folder"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="var(--fa)"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h3.1l1.5 1.5H13c.7 0 1.25.55 1.25 1.25v6.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" />
        </svg>
        <b className="ell">{project.name}</b>
        <span className="path" title={project.cwd}>
          {shortenPath(project.cwd)}
        </span>
        <ProjectSummary sessions={project.sessions} above={above} />
      </button>
      {!collapsed && (
        <ul className="ra-list" id={rowsId}>
          {project.sessions.map((session) => (
            <SessionRow key={session.key} session={session} ctx={ctx} />
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
  aboveByProject,
  collapsed,
  onToggleProject,
  ctx,
}: {
  decisions: PendingDecision[];
  waiting: Session[];
  sessionByKey: Map<string, Session>;
  projects: Project[];
  aboveByProject: Map<string, number>;
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
          above={aboveByProject.get(project.key) ?? 0}
          collapsed={collapsed.has(project.key)}
          onToggle={() => onToggleProject(project.key)}
          ctx={ctx}
        />
      ))}
    </>
  );
}
