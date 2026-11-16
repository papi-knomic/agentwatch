import { useEffect, useRef, useState } from "react";
import { agentCaption, alertTitle, faviconHref, notificationBody } from "./alerts";
import { projectName } from "./board";
import { DecisionPanel } from "./DecisionPanel";
import type { PendingDecision, Session, ToolInfo } from "./useAgentStream";

type Permission = NotificationPermission | "unsupported";

function currentPermission(): Permission {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

/**
 * Tells the user a prompt is waiting even when this tab is behind another window: the tab title and favicon carry the
 * count, and (opt-in, via the button in the Waiting area) a browser notification names the agent and project. Never
 * the command or plan.
 */
export function useDecisionAlerts(
  decisions: PendingDecision[],
  attention: number,
  describe: (decision: PendingDecision) => { tool: string; project: string | undefined },
) {
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const notified = useRef(new Set<string>());
  const describeRef = useRef(describe);
  describeRef.current = describe;

  useEffect(() => {
    document.title = alertTitle(decisions.length, attention);
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (link) link.href = faviconHref(decisions.length);
  }, [decisions.length, attention]);

  useEffect(() => {
    const ids = new Set(decisions.map((d) => d.id));
    for (const id of notified.current) if (!ids.has(id)) notified.current.delete(id);
    if (permission !== "granted" || !document.hidden) {
      // Remember them anyway: showing a stale one when the tab is hidden later would be noise.
      for (const id of ids) notified.current.add(id);
      return;
    }
    for (const decision of decisions) {
      if (notified.current.has(decision.id)) continue;
      notified.current.add(decision.id);
      const { tool, project } = describeRef.current(decision);
      try {
        const note = new Notification("AgentWatch", {
          body: notificationBody(tool, project),
          tag: decision.id,
        });
        note.onclick = () => {
          window.focus();
          note.close();
        };
      } catch {
        // Some browsers refuse `new Notification` (e.g. mobile); the title and favicon still work.
      }
    }
  }, [decisions, permission]);

  const enable = () => {
    if (permission === "unsupported") return;
    void Notification.requestPermission()
      .then(setPermission)
      .catch(() => setPermission(currentPermission()));
  };
  return { permission, enable };
}

function useSecond(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Every pending prompt, in one place at the top: it ignores the agent filter, collapsed folders and scrolling, so
 * nothing that is holding an agent up can be missed.
 */
export function WaitingPanel({
  decisions,
  sessions,
  toolById,
  canAnswer,
  permission,
  onEnableAlerts,
}: {
  decisions: PendingDecision[];
  sessions: Session[];
  toolById: Map<string, ToolInfo>;
  canAnswer: boolean;
  permission: Permission;
  onEnableAlerts: () => void;
}) {
  const now = useSecond();
  if (decisions.length === 0) return null;
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  return (
    <section className="waiting" aria-label="Waiting for you" aria-live="polite">
      <div className="waiting-head">
        <h2 className="waiting-title">
          Waiting for you <span className="lane-count">{decisions.length}</span>
        </h2>
        {permission === "default" && (
          <button type="button" className="text-button" onClick={onEnableAlerts}>
            Enable browser alerts
          </button>
        )}
      </div>
      <p className="waiting-note">
        Claude Code is holding its own prompt back while it waits for you here. Answer here, or in the
        terminal when this runs out.
      </p>
      {decisions.map((decision) => {
        const session = byKey.get(decision.sessionKey);
        const tool = session ? toolById.get(session.tool) : undefined;
        const caption = agentCaption(decision);
        const left = Math.max(0, Math.round((Date.parse(decision.expiresAt) - now) / 1000));
        return (
          <div className="waiting-item" key={decision.id}>
            <p className="waiting-who">
              <strong>{session?.title?.trim() || (session ? projectName(session.cwd) : "A session")}</strong>
              {session && (
                <span>
                  {" · "}
                  {tool?.label ?? session.tool}
                  {session.title?.trim() ? ` · ${projectName(session.cwd)}` : ""}
                </span>
              )}
              {caption && <span className="waiting-agent">{caption}</span>}
              <span className="waiting-left" title="Then Claude Code asks in the terminal instead">
                {left}s left
              </span>
            </p>
            <DecisionPanel decision={decision} canAnswer={canAnswer} />
          </div>
        );
      })}
    </section>
  );
}
