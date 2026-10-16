import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { APP_DISPLAY_NAME, APP_NAME } from "../../src/core/constants.js";
import {
  groupByProject,
  isFinished,
  isStalled,
  needsApprovalHint,
  needsYou,
  type Project,
  projectName,
  type Status,
  sortByUrgency,
  statusDuration,
  statusSince,
} from "./board";
import { SetupPanel } from "./SetupPanel";
import { useSetup } from "./setup";
import {
  type Connection,
  dismissSession,
  openSession,
  type Session,
  type ToolInfo,
  useAgentStream,
} from "./useAgentStream";

const STATUS_LABEL: Record<Status, string> = {
  needs_input: "Needs input",
  error: "Error",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A per-browser preference; falls back to the default when storage is unavailable. */
function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "true";
    } catch {
      return fallback;
    }
  });
  const update = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Only a convenience.
    }
  };
  return [value, update];
}

export function App() {
  const { sessions, tools, connection } = useAgentStream();
  const { setup, replace: replaceSetup } = useSetup();
  // Older servers have no setup endpoint; the plain empty state covers that.
  const readySetup = setup !== null && setup !== "unavailable" ? setup : null;
  const [hideFinished, setHideFinished] = useStoredFlag("hide-finished", false);
  const [collapsedProjects, toggleProject] = useCollapsedProjects();
  const now = useNow(15_000);

  const toolById = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);
  const attention = sortByUrgency(sessions.filter(needsYou));
  const finished = sessions.filter(isFinished);
  const projects = groupByProject(sessions.filter((s) => !needsYou(s) && !(hideFinished && isFinished(s))));
  // A tag that says the same thing on every row is noise.
  const showTool = new Set(sessions.map((s) => s.tool)).size > 1;
  const count = (status: Status) => sessions.filter((s) => s.status === status).length;

  useEffect(() => {
    document.title = attention.length > 0 ? `(${attention.length}) ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;
  }, [attention.length]);

  const rowProps = { toolById, showTool, now };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Logo />
            <span>{APP_DISPLAY_NAME}</span>
          </div>
          <div className="counts">
            <Count tone="attention" value={attention.length} label="need you" />
            <Count tone="working" value={count("working")} label="working" />
            <Count tone="done" value={finished.length} label="done" />
          </div>
          {finished.length > 0 && (
            <button
              type="button"
              className={hideFinished ? "toggle on" : "toggle"}
              aria-pressed={hideFinished}
              onClick={() => setHideFinished(!hideFinished)}
            >
              Hide finished
            </button>
          )}
          <ConnectionBadge connection={connection} />
        </div>
      </header>

      <main className="content">
        {sessions.length === 0 ? (
          readySetup ? (
            <SetupPanel setup={readySetup} onSetup={replaceSetup} prominent />
          ) : (
            <EmptyState connection={connection} />
          )
        ) : (
          <>
            {attention.length > 0 && (
              <section className="lane" aria-labelledby="lane-title">
                <h2 id="lane-title" className="lane-head">
                  Needs you <span className="lane-count">{attention.length}</span>
                </h2>
                <ul className="rows">
                  {attention.map((session) => (
                    <SessionRow key={session.key} session={session} showProject {...rowProps} />
                  ))}
                </ul>
              </section>
            )}

            {/* Sessions that need you are in the lane above, so collapsing a folder never hides them. */}
            {projects.map((project) => (
              <ProjectCard
                key={project.key}
                project={project}
                collapsed={collapsedProjects.has(project.key)}
                onToggle={() => toggleProject(project.key)}
                {...rowProps}
              />
            ))}

            {hideFinished && finished.length > 0 && (
              <p className="hidden-note">
                {finished.length} finished {finished.length === 1 ? "session" : "sessions"} hidden ·{" "}
                <button type="button" className="text-button" onClick={() => setHideFinished(false)}>
                  Show
                </button>
              </p>
            )}

            {readySetup && <SetupPanel setup={readySetup} onSetup={replaceSetup} prominent={false} />}
          </>
        )}
      </main>
    </div>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="1" width="8" height="8" rx="2.5" />
      <rect x="11" y="1" width="8" height="8" rx="2.5" />
      <rect x="1" y="11" width="8" height="8" rx="2.5" />
      <rect className="logo-accent" x="11" y="11" width="8" height="8" rx="4" />
    </svg>
  );
}

function Count({ tone, value, label }: { tone: string; value: number; label: string }) {
  return (
    <span className={`count tone-${tone}${value > 0 ? " nonzero" : ""}`}>
      <span className="count-dot" />
      <strong>{value}</strong>
      <span className="count-label">{label}</span>
    </span>
  );
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const label = connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className={`connection connection-${connection}`} role="status">
      <span className="connection-dot" />
      {label}
    </span>
  );
}

interface RowContext {
  toolById: Map<string, ToolInfo>;
  showTool: boolean;
  now: number;
}

/** Collapsed project folders, remembered per browser by project key. */
function useCollapsedProjects(): [Set<string>, (key: string) => void] {
  const STORAGE_KEY = "collapsed-projects";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Only a convenience.
    }
  };
  return [collapsed, toggle];
}

const SUMMARY_PARTS: [Status, string][] = [
  ["working", "working"],
  ["idle", "idle"],
  ["done", "done"],
];

/** Stays visible when the folder is collapsed, so it still says what's going on inside. */
function ProjectSummary({ sessions }: { sessions: Session[] }) {
  const parts = SUMMARY_PARTS.map(
    ([status, label]) => [status, sessions.filter((s) => s.status === status).length, label] as const,
  ).filter(([, n]) => n > 0);
  return (
    <span className="project-summary">
      {parts.map(([status, n, label]) => (
        <span key={status} className={`summary-part tone-${status}`}>
          <span className="summary-dot" />
          {n} {label}
        </span>
      ))}
    </span>
  );
}

function ProjectCard({
  project,
  collapsed,
  onToggle,
  ...context
}: { project: Project; collapsed: boolean; onToggle: () => void } & RowContext) {
  const rowsId = `rows-${project.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <section className={collapsed ? "project collapsed" : "project"} aria-label={project.name}>
      <button
        type="button"
        className="project-head"
        aria-expanded={!collapsed}
        aria-controls={rowsId}
        onClick={onToggle}
      >
        <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <svg className="folder" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" />
        </svg>
        <span className="project-name">{project.name}</span>
        <span className="project-path" title={project.cwd}>
          {project.cwd}
        </span>
        <ProjectSummary sessions={project.sessions} />
      </button>
      {!collapsed && (
        <ul className="rows" id={rowsId}>
          {project.sessions.map((session) => (
            <SessionRow key={session.key} session={session} showProject={false} {...context} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusIcon({ status }: { status: Status }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case "needs_input":
      return (
        <svg className="status-icon" viewBox="0 0 16 16" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="7" className="fill" />
          <path d="M8 4.5v4" className="glyph" />
          <circle cx="8" cy="11.25" r="0.9" className="glyph-dot" />
        </svg>
      );
    case "error":
      return (
        <svg className="status-icon" viewBox="0 0 16 16" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="7" className="fill" />
          <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" className="glyph" />
        </svg>
      );
    case "done":
      return (
        <svg className="status-icon" viewBox="0 0 16 16" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="7" className="fill" />
          <path d="M5 8.25l2 2 4-4.25" className="glyph" />
        </svg>
      );
    case "working":
      return (
        <svg className="status-icon spin" viewBox="0 0 16 16" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="6" className="track" />
          <path d="M8 2a6 6 0 0 1 6 6" className="arc" />
        </svg>
      );
    case "idle":
      return (
        <svg className="status-icon" viewBox="0 0 16 16" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="5.5" className="ring" />
        </svg>
      );
  }
}

/** What the row says under its title. Finished and idle rows need nothing beyond their time. */
function detailFor(session: Session): string | undefined {
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

function SessionRow({
  session,
  toolById,
  showTool,
  showProject,
  now,
}: { session: Session; showProject: boolean } & RowContext) {
  const tool = toolById.get(session.tool);
  const project = projectName(session.cwd);
  const title = session.title?.trim() ? session.title : undefined;
  const name = title ?? (showProject ? project : "Untitled session");
  const detail = detailFor(session);
  const stalled = isStalled(session);
  const source = [showTool ? (tool?.label ?? session.tool) : undefined, session.host].filter(Boolean);
  const openTarget =
    session.host === "Codex Desktop" ? "Codex" : session.host?.startsWith("VS Code") ? "VS Code" : undefined;

  return (
    <li
      className={`row status-${session.status}${stalled ? " stalled" : ""}`}
      style={{ "--tool": tool?.color ?? "var(--muted)" } as CSSProperties}
    >
      <StatusIcon status={session.status} />
      <div className="row-main">
        <div className="row-title">
          <span className={title ? "row-name" : "row-name untitled"} title={title ?? session.cwd}>
            {name}
          </span>
          {showProject && title && (
            <span className="row-project" title={session.cwd}>
              {project}
            </span>
          )}
          {stalled && (
            <span className="badge badge-warn" title="No events for 10 minutes or more">
              No activity
            </span>
          )}
        </div>
        {detail && <p className="row-detail">{detail}</p>}
        {needsApprovalHint(session) && (
          <p className="row-hint">Approved it? This updates when the command finishes.</p>
        )}
      </div>
      <div className="row-meta">
        <span className="row-since" title={new Date(statusSince(session)).toLocaleString()}>
          {statusDuration(session, now)}
        </span>
        {source.length > 0 && <span className="row-source">{source.join(" · ")}</span>}
      </div>
      <div className="row-actions">
        {openTarget && <OpenButton sessionKey={session.key} target={openTarget} />}
        <button
          type="button"
          className="icon-button dismiss"
          title="Dismiss"
          aria-label={`Dismiss ${name}`}
          onClick={() => void dismissSession(session.key)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </div>
    </li>
  );
}

type OpenState = "idle" | "opening" | "failed";

/** Shows progress right away: VS Code takes about a second to switch windows and then tabs. */
function OpenButton({ sessionKey, target }: { sessionKey: string; target: string }) {
  const [state, setState] = useState<OpenState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), state === "opening" ? 1500 : 2500);
    return () => clearTimeout(id);
  }, [state]);

  const open = async () => {
    setState("opening");
    if (!(await openSession(sessionKey))) setState("failed");
  };

  return (
    <button
      type="button"
      className={`open-button open-${state}`}
      title={`Open this session in ${target}`}
      disabled={state === "opening"}
      onClick={() => void open()}
    >
      {state === "opening" ? (
        <svg className="spin" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5L7.5 8.5" />
        </svg>
      )}
      <span>
        {state === "opening" ? "Opening" : state === "failed" ? "Couldn't open" : `Open in ${target}`}
      </span>
    </button>
  );
}

function EmptyState({ connection }: { connection: Connection }) {
  if (connection !== "live") {
    return (
      <div className="empty">
        <p className="empty-lead">Connecting to the local server…</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>No agent sessions yet</h2>
      <p className="empty-lead">
        Sessions appear here as soon as an agent with hooks installed starts or finishes a turn.
      </p>
      <ol>
        <li>
          Install the hooks <code>{APP_NAME} install --tool claude-code</code>
        </li>
        <li>Start a new session in VS Code, a terminal or the desktop app.</li>
      </ol>
    </div>
  );
}
