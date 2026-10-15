import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { APP_NAME } from "../../src/core/constants.js";
import {
  type Connection,
  dismissSession,
  type Session,
  type ToolInfo,
  useAgentStream,
} from "./useAgentStream";

type Status = Session["status"];

const SECTIONS: { id: string; title: string; hint: string; statuses: Status[] }[] = [
  {
    id: "attention",
    title: "Needs you",
    hint: "Waiting on a permission or an answer",
    statuses: ["needs_input", "error"],
  },
  { id: "done", title: "Done", hint: "Finished and ready for a follow-up", statuses: ["done"] },
  { id: "working", title: "Working", hint: "", statuses: ["working"] },
  { id: "idle", title: "Idle", hint: "", statuses: ["idle"] },
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

function vscodeUrl(cwd: string): string {
  let path = cwd.replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return `vscode://file${encodeURI(path)}`;
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
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
  const [filter, setFilter] = useState<string | null>(null);
  const now = useNow(30_000);

  const toolById = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);
  const visible = filter ? sessions.filter((s) => s.tool === filter) : sessions;
  const attention = sessions.filter((s) => s.status === "needs_input" || s.status === "error").length;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) Agent Dashboard` : "Agent Dashboard";
  }, [attention]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Agents</h1>
        </div>
        <Summary sessions={sessions} />
        <ConnectionBadge connection={connection} />
      </header>

      {tools.length > 1 && (
        <nav className="filters" aria-label="Filter by tool">
          <button
            type="button"
            className={filter === null ? "chip active" : "chip"}
            onClick={() => setFilter(null)}
          >
            All
          </button>
          {tools.map((tool) => (
            <button
              type="button"
              key={tool.id}
              className={filter === tool.id ? "chip active" : "chip"}
              onClick={() => setFilter(tool.id)}
            >
              <span className="dot" style={{ background: tool.color }} />
              {tool.label}
            </button>
          ))}
        </nav>
      )}

      {visible.length === 0 ? (
        <EmptyState connection={connection} />
      ) : (
        SECTIONS.map((section) => {
          const items = visible
            .filter((s) => section.statuses.includes(s.status))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          if (items.length === 0) return null;
          return (
            <section key={section.id} className={`section section-${section.id}`}>
              <h2>
                {section.title} <span className="count">{items.length}</span>
                {section.hint && <span className="hint">{section.hint}</span>}
              </h2>
              <div className="grid">
                {items.map((session) => (
                  <SessionCard
                    key={session.key}
                    session={session}
                    tool={toolById.get(session.tool)}
                    now={now}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

function Summary({ sessions }: { sessions: Session[] }) {
  const count = (statuses: Status[]) => sessions.filter((s) => statuses.includes(s.status)).length;
  const items = [
    { label: "need you", value: count(["needs_input", "error"]), tone: "attention" },
    { label: "working", value: count(["working"]), tone: "working" },
    { label: "done", value: count(["done"]), tone: "done" },
  ];
  return (
    <ul className="summary">
      {items.map((item) => (
        <li key={item.label} className={`summary-item tone-${item.tone}`}>
          <strong>{item.value}</strong> {item.label}
        </li>
      ))}
    </ul>
  );
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const label =
    connection === "live" ? "Live" : connection === "connecting" ? "Connecting…" : "Reconnecting…";
  return (
    <span className={`connection connection-${connection}`} role="status">
      <span className="dot" />
      {label}
    </span>
  );
}

function SessionCard({ session, tool, now }: { session: Session; tool: ToolInfo | undefined; now: number }) {
  const color = tool?.color ?? "var(--muted)";
  return (
    <article className={`card status-${session.status}`} style={{ "--tool": color } as CSSProperties}>
      <div className="card-head">
        <span className="tool-badge">
          <span className="dot" />
          {tool?.label ?? session.tool}
        </span>
        {session.host && <span className="host">{session.host}</span>}
        <button
          type="button"
          className="dismiss"
          title="Dismiss"
          aria-label={`Dismiss ${projectName(session.cwd)}`}
          onClick={() => void dismissSession(session.key)}
        >
          ×
        </button>
      </div>
      <h3 className="project" title={session.cwd}>
        {projectName(session.cwd)}
      </h3>
      <p className="path">{session.cwd}</p>
      {session.message && <p className="message">{session.message}</p>}
      <div className="card-foot">
        <span className="status-pill">{STATUS_LABEL[session.status]}</span>
        <time dateTime={session.updatedAt} title={new Date(session.updatedAt).toLocaleString()}>
          {timeAgo(session.updatedAt, now)}
        </time>
        <a className="open" href={vscodeUrl(session.cwd)}>
          Open in VS Code
        </a>
      </div>
    </article>
  );
}

function EmptyState({ connection }: { connection: Connection }) {
  if (connection !== "live") {
    return <p className="empty">Connecting to the local server…</p>;
  }
  return (
    <div className="empty">
      <h2>No agent sessions yet</h2>
      <p>Sessions show up here as soon as an agent with hooks installed starts or finishes a turn.</p>
      <ol>
        <li>
          Install the hooks: <code>{APP_NAME} install --tool claude-code</code>
        </li>
        <li>Start a new Claude Code session anywhere: VS Code, a terminal, or the desktop app.</li>
      </ol>
    </div>
  );
}
