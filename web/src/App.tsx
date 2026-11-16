import { useEffect, useMemo, useState } from "react";
import { APP_DISPLAY_NAME, APP_NAME } from "../../src/core/constants.js";
import {
  agentsInUse,
  groupByProject,
  isFinished,
  matchesAgent,
  needsYou,
  projectName,
  sortByUrgency,
} from "./board";
import { useDecisionAlerts } from "./decisionAlerts";
import { ListView, type ViewContext } from "./ListView";
import { GetNotifications, NotPaired, PairPage } from "./PairPage";
import { StatusIcon } from "./parts";
import { type Me, pairCodeFromHash, useMe, useUnpairedWatch } from "./remote";
import { type SettingsTab, settingsHref, useRoute } from "./route";
import { SettingsPage, setupNeedsAttention } from "./Settings";
import { useSetup } from "./setup";
import { useCollapsedProjects, useStoredFlag, useStoredString } from "./storage";
import { SidePanel, TableView } from "./TableView";
import { Toolbar } from "./Toolbar";
import { type Connection, type PendingDecision, useAgentStream } from "./useAgentStream";
import { useNow } from "./useNow";
import {
  compareSessions,
  DEFAULT_SORT,
  firstDirection,
  matchesQuery,
  matchesStatus,
  nextSort,
  parseView,
  type Sort,
  type SortKey,
  type StatusFilter,
  sortSessions,
  statusCounts,
  type ViewMode,
  withDecisions,
} from "./view";

/** Decides what to show: the dashboard, the pairing form (phone, after scanning the QR code) or "not paired". */
export function App() {
  const { state, reload, markUnpaired } = useMe();
  const code = pairCodeFromHash();
  if (state.kind === "loading") return null;
  const remoteSide = state.kind === "unpaired" || (state.kind === "ready" && state.me.remote);
  if (code && remoteSide) return <PairPage code={code} onPaired={reload} />;
  if (state.kind === "unpaired") return <NotPaired />;
  return <Dashboard me={state.kind === "ready" ? state.me : { remote: false }} onUnpaired={markUnpaired} />;
}

function Dashboard({ me, onUnpaired }: { me: Me; onUnpaired: () => void }) {
  const { sessions: streamed, tools, connection, decisions } = useAgentStream();
  // A session with a prompt waiting here needs you, whatever its last hook said; everything below sees that.
  const sessions = useMemo(() => withDecisions(streamed, decisions), [streamed, decisions]);
  // A paired phone can't see or change setup (the server refuses it); it also can't open apps on the PC.
  const remote = me.remote;
  const { setup, replace: replaceSetup } = useSetup(!remote);
  const route = useRoute();
  useUnpairedWatch(remote && connection === "reconnecting", onUnpaired);
  // Older servers have no setup endpoint; the plain empty state covers that.
  const readySetup = setup !== null && setup !== "unavailable" ? setup : null;

  const [hideFinished, setHideFinished] = useStoredFlag("hide-finished", false);
  const [groupTable, setGroupTable] = useStoredFlag("table-group", false);
  const [collapsedProjects, toggleProject] = useCollapsedProjects();
  const [storedAgent, setAgent] = useStoredString("agent-filter");
  const [storedView, setStoredView] = useStoredString("view");
  const view: ViewMode = parseView(storedView);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [picked, setPicked] = useState<{ key: string; opener: HTMLElement | null } | null>(null);
  const now = useNow(15_000);
  const second = useNow(1000);

  const toolById = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);
  const toolLabel = (tool: string) => toolById.get(tool)?.label ?? tool;
  const agents = agentsInUse(sessions, tools);
  // A remembered filter for an agent with nothing on the board shows everything.
  const agent = agents.some((a) => a.id === storedAgent) ? storedAgent : null;
  const sessionByKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);

  // The top bar and the tab title count every agent: a filter must never hide that something needs you.
  const allAttention = sessions.filter(needsYou).length;
  const working = sessions.filter((s) => s.status === "working").length;
  const finishedAll = sessions.filter(isFinished).length;

  const base = sessions.filter(
    (s) => matchesAgent(s, agent) && matchesQuery(s, query, toolById.get(s.tool)?.label),
  );
  const counts = statusCounts(base);
  const filtered = base.filter((s) => matchesStatus(s, status) && !(hideFinished && isFinished(s)));
  const hiddenFinished = hideFinished ? base.filter(isFinished).length : 0;
  const filtersActive = query.trim() !== "" || agent !== null || status !== "all";
  const clearFilters = () => {
    setQuery("");
    setAgent(null);
    setStatus("all");
  };

  const decisionsBySession = useMemo(() => {
    const map = new Map<string, PendingDecision[]>();
    for (const d of decisions) map.set(d.sessionKey, [...(map.get(d.sessionKey) ?? []), d]);
    return map;
  }, [decisions]);

  const alerts = useDecisionAlerts(decisions, allAttention, (decision) => {
    const session = sessionByKey.get(decision.sessionKey);
    return {
      tool: (session && toolById.get(session.tool)?.label) ?? session?.tool ?? "An agent",
      project: session ? projectName(session.cwd) : undefined,
    };
  });

  // Forget the filter once that agent's sessions are gone, so its next session doesn't silently hide the rest.
  useEffect(() => {
    if (connection === "live" && storedAgent !== null && agent === null) setAgent(null);
  }, [connection, storedAgent, agent, setAgent]);

  // The panel belongs to a session: when it ends or is dismissed, the panel goes with it.
  const pickedSession = picked ? sessionByKey.get(picked.key) : undefined;
  useEffect(() => {
    if (picked && !pickedSession && connection === "live") setPicked(null);
  }, [picked, pickedSession, connection]);

  const needsSetupAttention = setupNeedsAttention(readySetup);
  const canAnswer = !me.remote || me.device.allowApprovals;
  const ctx: ViewContext = { toolById, showTool: agents.length > 1, now, remote, canAnswer };
  const onSortColumn = (key: SortKey) => setSort((current) => nextSort(current, key));

  // List view: cards for what can be answered here, one-line rows for the rest of what needs you, then folders.
  const cardKeys = new Set(decisions.map((d) => d.sessionKey));
  const waitingRows = sortByUrgency(sessions.filter((s) => needsYou(s) && !cardKeys.has(s.key)));
  const projects = groupByProject(filtered.filter((s) => !needsYou(s) && !cardKeys.has(s.key)));

  // Table view: every filtered row, sorted; needs-you rows lead by default.
  const tableRows = sortSessions(filtered, sort, (s) => toolLabel(s.tool));
  const tableProjects = groupTable
    ? groupByProject(tableRows, (a, b) => compareSessions(a, b, sort, (s) => toolLabel(s.tool)))
    : null;
  const hiddenAttention = allAttention - filtered.filter(needsYou).length;
  const noMatches =
    view === "list" ? projects.length + waitingRows.length + decisions.length === 0 : tableRows.length === 0;

  return (
    <div className="app">
      <header className="top">
        <div className="top-in">
          <div className="brand">
            <Logo />
            <span>{APP_DISPLAY_NAME}</span>
          </div>
          <Counts attention={allAttention} working={working} done={finishedAll} className="counts" />
          <span className="sp" />
          <ConnectionBadge connection={connection} />
          {/* Setup is loopback-only on the server, so a paired phone gets no gear. */}
          {!remote && (
            <a
              className={`gear btn ico ghost${route.page === "settings" ? " on" : ""}`}
              href={route.page === "settings" ? "#/" : settingsHref()}
              aria-label={needsSetupAttention ? "Settings (needs attention)" : "Settings"}
              title="Settings"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6.48 3.03L6.8 1.2H9.2L9.52 3.03A5.2 5.2 0 0 1 10.44 3.41L11.96 2.35L13.65 4.04L12.59 5.56A5.2 5.2 0 0 1 12.97 6.48L14.8 6.8V9.2L12.97 9.52A5.2 5.2 0 0 1 12.59 10.44L13.65 11.96L11.96 13.65L10.44 12.59A5.2 5.2 0 0 1 9.52 12.97L9.2 14.8H6.8L6.48 12.97A5.2 5.2 0 0 1 5.56 12.59L4.04 13.65L2.35 11.96L3.41 10.44A5.2 5.2 0 0 1 3.03 9.52L1.2 9.2V6.8L3.03 6.48A5.2 5.2 0 0 1 3.41 5.56L2.35 4.04L4.04 2.35L5.56 3.41A5.2 5.2 0 0 1 6.48 3.03Z" />
                <circle cx="8" cy="8" r="2.25" />
              </svg>
              {needsSetupAttention && <span className="dot" />}
            </a>
          )}
        </div>
      </header>
      {/* On a phone the counts get their own row under the header. */}
      <div className="pcounts-wrap">
        <Counts attention={allAttention} working={working} done={finishedAll} className="pcounts" />
      </div>

      <main className="content">
        {!remote && route.page === "settings" ? (
          <SettingsPage
            tab={route.tab}
            setup={readySetup}
            onSetup={replaceSetup}
            permission={alerts.permission}
            onEnableAlerts={alerts.enable}
          />
        ) : (
          <>
            {remote && <GetNotifications />}
            {sessions.length === 0 ? (
              readySetup && !readySetup.tools.some((tool) => tool.connected) ? (
                <WelcomeCard />
              ) : (
                <EmptyState connection={connection} showSettings={!remote} />
              )
            ) : (
              <>
                <Toolbar
                  query={query}
                  onQuery={setQuery}
                  agents={agents}
                  totalSessions={sessions.length}
                  agent={agent}
                  onAgent={setAgent}
                  status={status}
                  onStatus={setStatus}
                  statusCounts={counts}
                  hasFinished={finishedAll > 0}
                  hideFinished={hideFinished}
                  onHideFinished={setHideFinished}
                  view={view}
                  onView={setStoredView}
                  groupTable={groupTable}
                  onGroupTable={setGroupTable}
                  sortKey={sort.key}
                  onSortKey={(key) => setSort({ key, dir: firstDirection(key) })}
                  permission={alerts.permission}
                  onEnableAlerts={alerts.enable}
                />

                {view === "table" && hiddenAttention > 0 && (
                  <p className="filter-note">
                    {hiddenAttention === 1
                      ? "1 session that needs you is hidden by the filters"
                      : `${hiddenAttention} sessions that need you are hidden by the filters`}{" "}
                    <button type="button" className="link" onClick={clearFilters}>
                      Show all
                    </button>
                  </p>
                )}

                {view === "list" ? (
                  <ListView
                    decisions={decisions}
                    waiting={waitingRows}
                    sessionByKey={sessionByKey}
                    projects={projects}
                    collapsed={collapsedProjects}
                    onToggleProject={toggleProject}
                    ctx={{ ...ctx, now: second }}
                  />
                ) : (
                  tableRows.length > 0 && (
                    <TableView
                      sessions={tableRows}
                      projects={tableProjects}
                      sort={sort}
                      onSort={onSortColumn}
                      decisionsBySession={decisionsBySession}
                      pickedKey={picked?.key ?? null}
                      onPick={(key, opener) => setPicked({ key, opener })}
                      ctx={ctx}
                    />
                  )
                )}

                {noMatches && (
                  <div className="no-match">
                    <p>{filtersActive ? "No sessions match these filters." : "Nothing to show."}</p>
                    {filtersActive && (
                      <button type="button" className="btn sm" onClick={clearFilters}>
                        Clear filters
                      </button>
                    )}
                  </div>
                )}

                {hiddenFinished > 0 && (
                  <p className="hidden-note">
                    {hiddenFinished} finished {hiddenFinished === 1 ? "session" : "sessions"} hidden ·{" "}
                    <button type="button" className="link" onClick={() => setHideFinished(false)}>
                      Show
                    </button>
                  </p>
                )}
              </>
            )}
          </>
        )}
      </main>

      {view === "table" && picked && pickedSession && (
        <SidePanel
          session={pickedSession}
          decisions={decisionsBySession.get(pickedSession.key) ?? []}
          ctx={{ ...ctx, now: second }}
          opener={picked.opener}
          onClose={() => setPicked(null)}
        />
      )}
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

function Counts({
  attention,
  working,
  done,
  className,
}: {
  attention: number;
  working: number;
  done: number;
  className: string;
}) {
  return (
    <fieldset className={className} aria-label="Session counts">
      <span className={attention > 0 ? "cnt hot" : "cnt"}>
        <StatusIcon status="needs_input" decorative />
        <b>{attention}</b> need you
      </span>
      <span className="cnt">
        <StatusIcon status="working" decorative />
        <b>{working}</b> working
      </span>
      <span className="cnt">
        <StatusIcon status="done" decorative />
        <b>{done}</b> done
      </span>
    </fieldset>
  );
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const label = connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className={`live connection-${connection}`} role="status">
      <i />
      {label}
    </span>
  );
}

/** First run: nothing connected and nothing running. Everything else lives on the Settings page. */
function WelcomeCard() {
  const tab: SettingsTab = "agents";
  return (
    <div className="empty">
      <h2>Welcome to {APP_DISPLAY_NAME}</h2>
      <p className="empty-lead">
        Connect your agents once, then start a new session in each tool. They all show up here.
      </p>
      <p className="empty-actions">
        <a className="primary-button" href={settingsHref(tab)}>
          Set up
        </a>
      </p>
    </div>
  );
}

function EmptyState({ connection, showSettings }: { connection: Connection; showSettings: boolean }) {
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
      {showSettings && (
        <p className="empty-more">
          Agents are managed in <a href={settingsHref()}>Settings</a>.
        </p>
      )}
    </div>
  );
}
