import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { APP_NAME } from "../../src/core/constants.js";
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

type Status = Session["status"];

const GROUPS: { id: string; title: string; statuses: Status[] }[] = [
  { id: "attention", title: "Needs you", statuses: ["needs_input", "error"] },
  { id: "working", title: "Working", statuses: ["working"] },
  { id: "done", title: "Done", statuses: ["done"] },
  { id: "idle", title: "Idle", statuses: ["idle"] },
];

const STATUS_LABEL: Record<Status, string> = {
  needs_input: "Needs input",
  error: "Error",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

function sessionTitle(session: Session): string | undefined {
  return session.title?.trim() ? session.title : undefined;
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function App() {
  const { sessions, tools, connection } = useAgentStream();
  const { setup, replace: replaceSetup } = useSetup();
  // Older servers have no setup endpoint; the plain empty state covers that.
  const readySetup = setup !== null && setup !== "unavailable" ? setup : null;
  const [filter, setFilter] = useState<string | null>(null);
  const now = useNow(15_000);

  const toolById = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);
  const visible = filter ? sessions.filter((s) => s.tool === filter) : sessions;
  const count = (statuses: Status[]) => sessions.filter((s) => statuses.includes(s.status)).length;
  const attention = count(["needs_input", "error"]);
  // A tag that says the same thing on every row is noise.
  const showTool = new Set(visible.map((s) => s.tool)).size > 1;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) Agents` : "Agents";
  }, [attention]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Logo />
            <span>Agents</span>
          </div>
          <div className="counts">
            <Count tone="attention" value={attention} label="need you" />
            <Count tone="working" value={count(["working"])} label="working" />
            <Count tone="done" value={count(["done"])} label="done" />
          </div>
          <ConnectionBadge connection={connection} />
        </div>
      </header>

      <main className="content">
        {tools.length > 1 && sessions.length > 0 && (
          <nav className="filters" aria-label="Filter by tool">
            <FilterChip active={filter === null} onClick={() => setFilter(null)} label="All" />
            {tools.map((tool) => (
              <FilterChip
                key={tool.id}
                active={filter === tool.id}
                onClick={() => setFilter(tool.id)}
                label={tool.label}
                color={tool.color}
              />
            ))}
          </nav>
        )}

        {sessions.length === 0 && readySetup ? (
          <SetupPanel setup={readySetup} onSetup={replaceSetup} prominent />
        ) : visible.length === 0 ? (
          <EmptyState connection={connection} filtered={filter !== null} />
        ) : (
          GROUPS.map((group) => {
            const items = visible
              .filter((s) => group.statuses.includes(s.status))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            if (items.length === 0) return null;
            return (
              <section key={group.id} className={`group group-${group.id}`}>
                <h2 className="group-head">
                  {group.title}
                  <span className="group-count">{items.length}</span>
                </h2>
                <ul className="rows">
                  {items.map((session) => (
                    <SessionRow
                      key={session.key}
                      session={session}
                      tool={toolById.get(session.tool)}
                      showTool={showTool}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}

        {sessions.length > 0 && readySetup && (
          <SetupPanel setup={readySetup} onSetup={replaceSetup} prominent={false} />
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

function FilterChip(props: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button
      type="button"
      className={props.active ? "chip active" : "chip"}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.color && <span className="chip-dot" style={{ background: props.color }} />}
      {props.label}
    </button>
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

function SessionRow(props: { session: Session; tool: ToolInfo | undefined; showTool: boolean; now: number }) {
  const { session, tool, now } = props;
  const project = projectName(session.cwd);
  const title = sessionTitle(session);
  const color = tool?.color ?? "var(--muted)";
  return (
    <li className={`row status-${session.status}`} style={{ "--tool": color } as CSSProperties}>
      <StatusIcon status={session.status} />
      <div className="row-main">
        <div className="row-title">
          <span className="row-name" title={title ?? session.cwd}>
            {title ?? project}
          </span>
          {title && (
            <span className="row-project" title={session.cwd}>
              {project}
            </span>
          )}
        </div>
        {session.message ? (
          <p className="row-message">{session.message}</p>
        ) : (
          <p className="row-path">{session.cwd}</p>
        )}
      </div>
      <div className="row-meta">
        {props.showTool && (
          <span className="tool-tag">
            <span className="tool-dot" />
            {tool?.label ?? session.tool}
          </span>
        )}
        {session.host && <span className="host">{session.host}</span>}
      </div>
      <time
        className="row-time"
        dateTime={session.updatedAt}
        title={new Date(session.updatedAt).toLocaleString()}
      >
        {timeAgo(session.updatedAt, now)}
      </time>
      <div className="row-actions">
        {/* Terminal tabs can't be focused from outside, so only VS Code sessions get a button. */}
        {session.host?.startsWith("VS Code") && <OpenButton sessionKey={session.key} />}
        <button
          type="button"
          className="icon-button dismiss"
          title="Dismiss"
          aria-label={`Dismiss ${title ?? project}`}
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
function OpenButton({ sessionKey }: { sessionKey: string }) {
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
      title="Open this session in VS Code"
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
      <span>{state === "opening" ? "Opening" : state === "failed" ? "Couldn't open" : "Open"}</span>
    </button>
  );
}

function EmptyState({ connection, filtered }: { connection: Connection; filtered: boolean }) {
  if (connection !== "live") {
    return (
      <div className="empty">
        <p className="empty-lead">Connecting to the local server…</p>
      </div>
    );
  }
  if (filtered) {
    return (
      <div className="empty">
        <p className="empty-lead">No sessions for this tool right now.</p>
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
