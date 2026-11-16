import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * Tracks a media query. Needed for the placeholder and the short agent names, which CSS can't change; the phone
 * breakpoint matches the stylesheet's (max-width: 480px).
 */
function useMediaQuery(query: string): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [matches, setMatches] = useState(() => supported && window.matchMedia(query).matches);
  useEffect(() => {
    if (!supported) return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query, supported]);
  return matches;
}

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

/** The sticky table header sits under the filter bar, which wraps on narrower windows: it needs the bar's height. */
function useBarHeight(bar: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const el = bar.current;
    const root = document.documentElement;
    if (!active || !el || typeof ResizeObserver === "undefined") return;
    const apply = () => root.style.setProperty("--cbar-h", `${el.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--cbar-h");
    };
  }, [bar, active]);
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

function Search({
  props,
  input,
  phone,
}: {
  props: ToolbarProps;
  input: RefObject<HTMLInputElement | null>;
  phone: boolean;
}) {
  return (
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
        placeholder={phone ? "Search" : "Search task, project, host, agent"}
        autoComplete="off"
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (props.query) props.onQuery("");
          else e.currentTarget.blur();
        }}
      />
    </label>
  );
}

function ViewSwitch({ props }: { props: ToolbarProps }) {
  const { view } = props;
  return (
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
  );
}

/** Desktop only, and only while the browser hasn't been asked yet. */
function AlertsChip({ props }: { props: ToolbarProps }) {
  if (props.permission !== "default") return null;
  return (
    <button type="button" className="chip" aria-pressed="false" onClick={props.onEnableAlerts}>
      Enable browser alerts
    </button>
  );
}

function HideFinishedChip({ props }: { props: ToolbarProps }) {
  if (!props.hasFinished) return null;
  return (
    <button
      type="button"
      className="chip hide-phone"
      aria-pressed={props.hideFinished}
      onClick={() => props.onHideFinished(!props.hideFinished)}
    >
      Hide finished
    </button>
  );
}

/** List view: the mockup's chip row (direction A) plus search and the view switch. */
function Filters({ props, phone }: { props: ToolbarProps; phone: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useSlashFocus(input);
  return (
    <fieldset className="filters" aria-label="Filters">
      {props.agents.length > 1 && (
        <>
          <button
            type="button"
            className="chip"
            aria-pressed={props.agent === null}
            onClick={() => props.onAgent(null)}
          >
            All <span className="n">{props.totalSessions}</span>
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
              {phone ? (a.label.split(" ")[0] ?? a.label) : a.label} <span className="n">{a.count}</span>
            </button>
          ))}
        </>
      )}
      <HideFinishedChip props={props} />
      {!phone && <AlertsChip props={props} />}
      <Search props={props} input={input} phone={phone} />
      <ViewSwitch props={props} />
    </fieldset>
  );
}

/** Table view: the mockup's command bar (direction C) plus the view switch. */
function CommandBar({ props, phone }: { props: ToolbarProps; phone: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useSlashFocus(input);
  useBarHeight(bar, true);
  return (
    <div className="cbar" ref={bar}>
      <fieldset className="stat" aria-label="Filter by status">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-label={`${tab.label} ${props.statusCounts[tab.id]}`}
            aria-pressed={props.status === tab.id}
            onClick={() => props.onStatus(tab.id)}
          >
            {tab.id === "needs" && <StatusIcon status="needs_input" decorative />}
            {tab.id === "working" && <StatusIcon status="working" decorative />}
            {tab.id === "done" && <StatusIcon status="done" decorative />}
            <b>{props.statusCounts[tab.id]}</b>
            <span className={tab.id === "all" ? undefined : "lbl"} aria-hidden="true">
              {tab.label}
            </span>
          </button>
        ))}
      </fieldset>
      <Search props={props} input={input} phone={phone} />
      {props.agents.length > 1 && (
        <select
          className="sel"
          aria-label="Agent"
          value={props.agent ?? ""}
          onChange={(e) => props.onAgent(e.target.value || null)}
        >
          <option value="">All agents</option>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
      <select
        className="sel sortsel"
        aria-label="Sort by"
        value={props.sortKey}
        onChange={(e) => props.onSortKey(e.target.value as SortKey)}
      >
        {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
          <option key={key} value={key}>
            Sort: {SORT_LABELS[key].toLowerCase()}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="chip"
        aria-pressed={props.groupTable}
        onClick={() => props.onGroupTable(!props.groupTable)}
      >
        Group by project
      </button>
      <HideFinishedChip props={props} />
      {!phone && <AlertsChip props={props} />}
      <ViewSwitch props={props} />
    </div>
  );
}

/** Search, filters and the view switch. Each view has its own bar, as in the mockup. */
export function Toolbar(props: ToolbarProps) {
  const phone = useMediaQuery("(max-width: 480px)");
  return props.view === "list" ? (
    <Filters props={props} phone={phone} />
  ) : (
    <CommandBar props={props} phone={phone} />
  );
}
