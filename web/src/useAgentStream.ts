import { useEffect, useState } from "react";
import type { PendingDecision } from "../../src/core/decision-types.js";
import type { Session } from "../../src/core/types.js";

export type { PendingDecision, Session };

export interface ToolInfo {
  id: string;
  label: string;
  color: string;
}

export type Connection = "connecting" | "live" | "reconnecting";

interface Snapshot {
  sessions: Session[];
  tools: ToolInfo[];
  /** Absent from older servers. */
  decisions?: PendingDecision[];
}

const PRESENCE_HEARTBEAT_MS = 20_000;

function randomClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

/** Subscribes to the server's SSE stream. EventSource reconnects on its own; each reconnect resends a snapshot. */
export function useAgentStream() {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [decisions, setDecisions] = useState<Map<string, PendingDecision>>(new Map());
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    // The server holds Claude Code's own prompt back while it waits for an answer from here, so it only does that
    // for a tab that says it is visible. Tell it on connect, on every visibility change, and now and then.
    const clientId = randomClientId();
    const source = new EventSource(`/api/stream?client=${clientId}`);
    const reportPresence = () => {
      fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, visible: document.visibilityState === "visible" }),
      }).catch(() => {});
    };
    document.addEventListener("visibilitychange", reportPresence);
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") reportPresence();
    }, PRESENCE_HEARTBEAT_MS);
    source.addEventListener("snapshot", (e) => {
      reportPresence();
      const data = JSON.parse((e as MessageEvent<string>).data) as Snapshot;
      setSessions(new Map(data.sessions.filter((s) => !s.hidden).map((s) => [s.key, s])));
      setTools(data.tools);
      setDecisions(new Map((data.decisions ?? []).map((d) => [d.id, d])));
      setConnection("live");
    });
    source.addEventListener("decision", (e) => {
      const decision = JSON.parse((e as MessageEvent<string>).data) as PendingDecision;
      setDecisions((prev) => new Map(prev).set(decision.id, decision));
    });
    source.addEventListener("decision-remove", (e) => {
      const { id } = JSON.parse((e as MessageEvent<string>).data) as { id: string };
      setDecisions((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    });
    source.addEventListener("upsert", (e) => {
      const session = JSON.parse((e as MessageEvent<string>).data) as Session;
      setSessions((prev) => {
        const next = new Map(prev);
        if (session.hidden) next.delete(session.key);
        else next.set(session.key, session);
        return next;
      });
    });
    source.addEventListener("remove", (e) => {
      const { key } = JSON.parse((e as MessageEvent<string>).data) as { key: string };
      setSessions((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
    source.onerror = () => setConnection("reconnecting");
    return () => {
      document.removeEventListener("visibilitychange", reportPresence);
      window.clearInterval(heartbeat);
      source.close();
    };
  }, []);

  return { sessions: [...sessions.values()], tools, connection, decisions: [...decisions.values()] };
}

async function postSessionAction(action: "dismiss" | "open", key: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function dismissSession(key: string): Promise<boolean> {
  return postSessionAction("dismiss", key);
}

/** The server opens it rather than a link here: it has to focus the right window first, then the tab. */
export function openSession(key: string): Promise<boolean> {
  return postSessionAction("open", key);
}

export type ResolveOutcome = "ok" | "answered" | "gone" | "failed";

/** Sends the answer to a pending prompt. 409/410 mean it was answered elsewhere or ran out of time. */
export async function resolveDecision(id: string, body: unknown): Promise<ResolveOutcome> {
  try {
    const res = await fetch(`/api/decisions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return "ok";
    if (res.status === 409) return "answered";
    if (res.status === 410 || res.status === 404) return "gone";
    return "failed";
  } catch {
    return "failed";
  }
}
