import { useEffect, useRef, useState } from "react";
import { alertTitle, faviconHref, notificationBody } from "./alerts";
import type { PendingDecision } from "./useAgentStream";

export type Permission = NotificationPermission | "unsupported";

function currentPermission(): Permission {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

/**
 * Tells the user a prompt is waiting even when this tab is behind another window: the tab title and favicon carry the
 * count, and (opt-in, via the bell button in the toolbar) a browser notification names the agent and project. Never
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
