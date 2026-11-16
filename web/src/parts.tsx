import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { Status } from "./board";
import { dismissSession, openSession, type ToolInfo } from "./useAgentStream";

export const STATUS_LABEL: Record<Status, string> = {
  needs_input: "Needs input",
  error: "Error",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

/**
 * Status is colour plus shape (filled circle with "!", filled square with "x", spinner arc, check ring, empty ring),
 * so it never rests on colour alone. Pass `decorative` when a text label sits right next to it.
 */
type A11y = { "aria-hidden": true } | { role: "img"; "aria-label": string };

function IconSvg({ name, a11y, children }: { name: string; a11y: A11y; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the accessible name is set through aria-label, or hidden when decorative
    <svg className={`ic ${name}`} viewBox="0 0 16 16" {...a11y}>
      {children}
    </svg>
  );
}

export function StatusIcon({ status, decorative = false }: { status: Status; decorative?: boolean }) {
  const a11y: A11y = decorative
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": STATUS_LABEL[status] };
  switch (status) {
    case "needs_input":
      return (
        <IconSvg name="needs_input" a11y={a11y}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M8 4.2v4.4" className="ink" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="1" className="ink-fill" />
        </IconSvg>
      );
    case "error":
      return (
        <IconSvg name="error" a11y={a11y}>
          <rect x="1.2" y="1.2" width="13.6" height="13.6" rx="3.4" fill="currentColor" />
          <path
            d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
            className="ink"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </IconSvg>
      );
    case "done":
      return (
        <IconSvg name="done" a11y={a11y}>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M5 8.2l2.1 2.1 3.9-4.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </IconSvg>
      );
    case "working":
      return (
        <IconSvg name="working" a11y={a11y}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
          <path
            className="arc"
            d="M8 2a6 6 0 0 1 6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </IconSvg>
      );
    case "idle":
      return (
        <IconSvg name="idle" a11y={a11y}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </IconSvg>
      );
  }
}

/** Agent colour is a square swatch; round and rounded-square shapes are reserved for status. */
export function ToolTag({ tool, fallback }: { tool: ToolInfo | undefined; fallback: string }) {
  return (
    <span className="tt" style={{ "--tool": tool?.color ?? "var(--mu)" } as CSSProperties}>
      <i />
      {tool?.label ?? fallback}
    </span>
  );
}

export function DismissButton({ sessionKey, name }: { sessionKey: string; name: string }) {
  return (
    <button
      type="button"
      className="btn sm ico ghost dismiss"
      title="Dismiss"
      aria-label={`Dismiss ${name}`}
      onClick={() => void dismissSession(sessionKey)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    </button>
  );
}

type OpenState = "idle" | "opening" | "failed";

/** Shows progress right away: VS Code takes about a second to switch windows and then tabs. */
export function OpenButton({ sessionKey, target }: { sessionKey: string; target: string }) {
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
      className={`btn sm open${state === "failed" ? " dng" : ""}`}
      title={`Open this session in ${target}`}
      aria-label={state === "idle" ? `Open in ${target}` : undefined}
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
