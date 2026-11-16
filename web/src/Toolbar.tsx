import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import type { AgentCount } from "./board";
import type { Permission } from "./decisionAlerts";
import { StatusIcon } from "./parts";
import type { SortKey, StatusFilter, ViewMode } from "./view";

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
];

export const SORT_LABELS: Record<SortKey, string> = {
  status: "Status",
  agent: "Agent",
  project: "Project",
  task: "Task",
  host: "Host",
  time: "Time",
};

/** Typing "/" anywhere outside a field jumps to search (only where there is a keyboard to use). */
function useSlashFocus(input: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      if (!window.matchMedia("(pointer: fine)").matches) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
}

export interface ToolbarProps {
  query: string;
  onQuery: (query: string) => void;
  agents: AgentCount[];
  totalSessions: number;
  agent: string | null;
  onAgent: (agent: string | null) => void;
  status: StatusFilter;
  onStatus: (status: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
  hasFinished: boolean;
  hideFinished: boolean;
  onHideFinished: (hide: boolean) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  groupTable: boolean;
  onGroupTable: (group: boolean) => void;
  sortKey: SortKey;
  onSortKey: (key: SortKey) => void;
  permission: Permission;
  onEnableAlerts: () => void;
}

function StatusSeg({ props }: { props: ToolbarProps }) {
  return (
    <fieldset className="stat" aria-label="Filter by status">
      {STATUS_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={props.status === tab.id}
          onClick={() => props.onStatus(tab.id)}
        >
          {tab.id === "needs" && <StatusIcon status="needs_input" decorative />}
          {tab.id === "working" && <StatusIcon status="working" decorative />}
          {tab.id === "done" && <StatusIcon status="done" decorative />}
          <span>{tab.label}</span>
          <b className="num">{props.statusCounts[tab.id]}</b>
        </button>
      ))}
    </fieldset>
  );
}

function BellButton({ props }: { props: ToolbarProps }) {
  if (props.permission !== "default") return null;
  return (
    <button
      type="button"
      className="btn ghost bell"
      title="Enable browser alerts"
      aria-label="Enable browser alerts"
      onClick={props.onEnableAlerts}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3" />
      </svg>
      <span className="bell-label">Enable alerts</span>
    </button>
  );
}

function AgentChips({ props }: { props: ToolbarProps }) {
  if (props.agents.length <= 1) return null;
  return (
    <fieldset className="chips agents" aria-label="Filter by agent">
      <button
        type="button"
        className="chip"
        aria-pressed={props.agent === null}
        onClick={() => props.onAgent(null)}
      >
        All agents <span className="n">{props.totalSessions}</span>
      </button>
      {props.agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className="chip"
          style={{ "--tool": a.color ?? "var(--mu)" } as CSSProperties}
          aria-pressed={props.agent === a.id}
          onClick={() => props.onAgent(props.agent === a.id ? null : a.id)}
        >
          <i className="sw" />
          {a.label} <span className="n">{a.count}</span>
        </button>
      ))}
    </fieldset>
  );
}

function ExtraChips({ props }: { props: ToolbarProps }) {
  return (
    <div className="chips tb-right">
      {props.hasFinished && (
        <button
          type="button"
          className="chip"
          aria-pressed={props.hideFinished}
          onClick={() => props.onHideFinished(!props.hideFinished)}
        >
          Hide finished
        </button>
      )}
      {props.view === "table" && (
        <>
          <button
            type="button"
            className="chip"
            aria-pressed={props.groupTable}
            onClick={() => props.onGroupTable(!props.groupTable)}
          >
            Group by project
          </button>
          <label className="sort-select">
            <span className="sr">Sort by</span>
            <select value={props.sortKey} onChange={(e) => props.onSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  Sort: {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/** How many of the filters hidden behind the phone's "Filters" button are in use. */
export function activeFilterCount(
  p: Pick<ToolbarProps, "status" | "agent" | "hideFinished" | "groupTable" | "view">,
): number {
  return (
    (p.status !== "all" ? 1 : 0) +
    (p.agent !== null ? 1 : 0) +
    (p.hideFinished ? 1 : 0) +
    (p.view === "table" && p.groupTable ? 1 : 0)
  );
}

/**
 * Search and filters shared by both views. On a wide screen everything sits inline; on a phone only search, a
 * "Filters" button and the view switch stay in the bar, and the rest opens in a panel under it.
 */
export function Toolbar(props: ToolbarProps) {
  const input = useRef<HTMLInputElement>(null);
  useSlashFocus(input);
  const [open, setOpen] = useState(false);
  const { view } = props;
  const active = activeFilterCount(props);

  return (
    <div className="toolbar">
      <div className="tb-row">
        <label className="search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <span className="sr">Search sessions</span>
          <input
            ref={input}
            type="search"
            value={props.query}
            placeholder="Search task, project, host, agent"
            autoComplete="off"
            onChange={(e) => props.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              if (props.query) props.onQuery("");
              else e.currentTarget.blur();
            }}
          />
          <span className="kbd" aria-hidden="true">
            /
          </span>
        </label>

        <div className="only-desk tb-inline">
          <StatusSeg props={props} />
        </div>

        <div className="tb-tools">
          <span className="only-desk tb-inline">
            <BellButton props={props} />
          </span>
          <button
            type="button"
            className="btn only-phone filters-btn"
            aria-expanded={open}
            aria-controls="tb-sheet"
            onClick={() => setOpen(!open)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
            </svg>
            <span>Filters</span>
            {active > 0 && <b className="fcount">{active}</b>}
            <span className="sr">{active > 0 ? ` (${active} active)` : ""}</span>
          </button>
          <fieldset className="seg" aria-label="View">
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => props.onView("list")}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
              </svg>
              <span>List</span>
            </button>
            <button
              type="button"
              aria-label="Table view"
              aria-pressed={view === "table"}
              onClick={() => props.onView("table")}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 3.5h11v9h-11zM2.5 7h11M6.5 3.5v9" />
              </svg>
              <span>Table</span>
            </button>
          </fieldset>
        </div>
      </div>

      <div className="tb-row only-desk">
        <AgentChips props={props} />
        <ExtraChips props={props} />
      </div>

      {open && (
        <div className="tb-sheet only-phone" id="tb-sheet">
          <StatusSeg props={props} />
          <AgentChips props={props} />
          <ExtraChips props={props} />
          <BellButton props={props} />
        </div>
      )}
    </div>
  );
}
