// biome-ignore-all lint/a11y/useSemanticElements: a div grid keeps the phone layout; ARIA table roles carry the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: rows and headers are containers; the buttons inside are the focus targets
import { type CSSProperties, type KeyboardEvent, useEffect, useRef } from "react";
import { isStalled, needsApprovalHint, type Project, projectName, statusDuration } from "./board";
import { DecisionCard } from "./DecisionCard";
import { detailFor, StalledBadge, sessionName, TimeCell, type ViewContext } from "./ListView";
import { DismissButton, OpenButton, STATUS_LABEL, StatusIcon, ToolTag } from "./parts";
import { dismissSession, type PendingDecision, type Session } from "./useAgentStream";
import { openTargetFor, type Sort, type SortKey, shortenPath } from "./view";

/** The first column is the status icon: its header shows only an arrow while the table is sorted by status. */
const COLUMNS: { key: SortKey; label: string; cls: string; visible: boolean }[] = [
  { key: "status", label: "Status", cls: "c-status", visible: false },
  { key: "agent", label: "agent", cls: "c-agent", visible: true },
  { key: "project", label: "project", cls: "c-proj", visible: true },
  { key: "task", label: "task", cls: "c-task", visible: true },
  { key: "host", label: "host", cls: "c-host", visible: true },
  { key: "time", label: "time", cls: "c-time", visible: true },
];

function Header({ sort, onSort }: { sort: Sort; onSort: (key: SortKey) => void }) {
  return (
    <div className="tr th" role="row">
      {COLUMNS.map((col) => (
        <div
          key={col.key}
          role="columnheader"
          className={col.cls}
          aria-sort={sort.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        >
          <button type="button" onClick={() => onSort(col.key)}>
            {col.visible ? col.label : <span className="sr">{col.label}</span>}
            <span className="ar" aria-hidden="true">
              {sort.key !== col.key || (col.key === "status" && sort.dir === "asc")
                ? ""
                : sort.dir === "asc"
                  ? "▲"
                  : "▼"}
            </span>
          </button>
        </div>
      ))}
      <div role="columnheader" className="c-act">
        <span className="sr">Actions</span>
      </div>
    </div>
  );
}

function TableRow({
  session,
  ctx,
  decisions,
  picked,
  onPick,
}: {
  session: Session;
  ctx: ViewContext;
  decisions: PendingDecision[];
  picked: boolean;
  onPick: (key: string, opener: HTMLElement) => void;
}) {
  const tool = ctx.toolById.get(session.tool);
  const project = projectName(session.cwd);
  const name = sessionName(session, false);
  const detail = detailFor(session);
  const openTarget = openTargetFor(session.host);
  const answerable = decisions.length > 0;
  return (
    <div
      role="row"
      className={`tr row st-${session.status}${picked ? " picked" : ""}`}
      style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}
    >
      <StatusIcon status={session.status} />
      <div role="cell" className="c-agent">
        <ToolTag tool={tool} fallback={session.tool} />
      </div>
      <div role="cell" className="c-proj proj ell" title={session.cwd}>
        {project}
      </div>
      <div role="cell" className="c-task task">
        <button
          type="button"
          className={session.title?.trim() ? "" : "untitled"}
          aria-haspopup="dialog"
          onClick={(e) => onPick(session.key, e.currentTarget)}
        >
          {name}
        </button>
        {detail && <span className="ell">{detail}</span>}
        {isStalled(session) && <StalledBadge />}
        {needsApprovalHint(session) && <em>Approved it? This updates when the command finishes.</em>}
      </div>
      <div role="cell" className="c-host host ell" title={session.host}>
        {session.host}
      </div>
      <div role="cell" className="c-time">
        <TimeCell session={session} now={ctx.now} />
      </div>
      <div role="cell" className="c-act acts">
        {answerable ? (
          <button
            type="button"
            className="btn sm pri"
            aria-haspopup="dialog"
            onClick={(e) => onPick(session.key, e.currentTarget)}
          >
            Answer
          </button>
        ) : (
          openTarget && !ctx.remote && <OpenButton sessionKey={session.key} target={openTarget} short />
        )}
        <DismissButton sessionKey={session.key} name={name} />
      </div>
      {/* Phone only: the columns collapse into a second line under the title. */}
      <div className="pm" aria-hidden="true">
        {detail}
      </div>
      <div className="meta" aria-hidden="true">
        <ToolTag tool={tool} fallback={session.tool} />
        <span className="host">{session.host ? `${project} · ${session.host}` : project}</span>
        <TimeCell session={session} now={ctx.now} />
      </div>
    </div>
  );
}

export function TableView({
  sessions,
  projects,
  sort,
  onSort,
  decisionsBySession,
  pickedKey,
  onPick,
  ctx,
}: {
  sessions: Session[];
  /** Set when grouped by project; rows are already sorted inside each group. */
  projects: Project[] | null;
  sort: Sort;
  onSort: (key: SortKey) => void;
  decisionsBySession: Map<string, PendingDecision[]>;
  pickedKey: string | null;
  onPick: (key: string, opener: HTMLElement) => void;
  ctx: ViewContext;
}) {
  const row = (session: Session) => (
    <TableRow
      key={session.key}
      session={session}
      ctx={ctx}
      decisions={decisionsBySession.get(session.key) ?? []}
      picked={pickedKey === session.key}
      onPick={onPick}
    />
  );
  return (
    <div className="tbl" role="table" aria-label="Sessions">
      <div role="rowgroup">
        <Header sort={sort} onSort={onSort} />
      </div>
      {projects === null ? (
        <div role="rowgroup">{sessions.map(row)}</div>
      ) : (
        projects.map((project) => (
          <div role="rowgroup" key={project.key} aria-label={project.name}>
            <div className="gr" title={project.cwd}>
              {`${project.name} ${shortenPath(project.cwd)} (${project.sessions.length})`}
            </div>
            {project.sessions.map(row)}
          </div>
        ))
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Slide-over (bottom sheet on a phone) with the decision card or an explanation, plus the session's details.
 * Esc and the scrim close it; Tab stays inside; focus goes back to what opened it.
 */
export function SidePanel({
  session,
  decisions,
  ctx,
  opener,
  onClose,
}: {
  session: Session;
  decisions: PendingDecision[];
  ctx: ViewContext;
  opener: HTMLElement | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const tool = ctx.toolById.get(session.tool);
  const name = sessionName(session, true);
  const openTarget = openTargetFor(session.host);
  const detail = detailFor(session);
  const hot = session.status === "needs_input" || session.status === "error";

  return (
    <>
      <div className="so-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="so"
        role="dialog"
        aria-modal="true"
        aria-label={`Session: ${name}`}
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <div className="so-h">
          <StatusIcon status={session.status} />
          <b className="ell" title={name}>
            {name}
          </b>
          <button
            type="button"
            className="btn ico ghost"
            aria-label="Close panel"
            data-autofocus
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        </div>
        <div className="so-b">
          {decisions.length > 0 ? (
            decisions.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                session={session}
                canAnswer={ctx.canAnswer}
                now={ctx.now}
              />
            ))
          ) : hot ? (
            <div className="dc">
              <p className="dc-q">{detail}</p>
              <p className="note">
                This can't be answered from the dashboard.
                {openTarget && !ctx.remote
                  ? ` Open it in ${openTarget} to reply.`
                  : " Reply where the agent runs."}
              </p>
              {needsApprovalHint(session) && (
                <p className="note">Approved it? This updates when the command finishes.</p>
              )}
            </div>
          ) : (
            detail && <p className="so-detail">{detail}</p>
          )}
          <dl className="kv">
            <dt>status</dt>
            <dd>
              {hot
                ? `${STATUS_LABEL[session.status]}, ${statusDuration(session, ctx.now).toLowerCase()}`
                : statusDuration(session, ctx.now)}
              {isStalled(session) && (
                <>
                  {" "}
                  <StalledBadge />
                </>
              )}
            </dd>
            <dt>agent</dt>
            <dd>
              <ToolTag tool={tool} fallback={session.tool} />
            </dd>
            <dt>project</dt>
            <dd>{projectName(session.cwd)}</dd>
            <dt>folder</dt>
            <dd title={session.cwd}>{shortenPath(session.cwd)}</dd>
            {session.host && (
              <>
                <dt>host</dt>
                <dd>{session.host}</dd>
              </>
            )}
          </dl>
          <div className="acts-row">
            {openTarget && !ctx.remote && <OpenButton sessionKey={session.key} target={openTarget} />}
            <button
              type="button"
              className="btn"
              onClick={() => {
                void dismissSession(session.key);
                onClose();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
