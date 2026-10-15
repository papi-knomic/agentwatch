import { useEffect, useState } from "react";
import type { Session } from "../../src/core/types.js";

export type { Session };

export interface ToolInfo {
  id: string;
  label: string;
  color: string;
}

export type Connection = "connecting" | "live" | "reconnecting";

interface Snapshot {
  sessions: Session[];
  tools: ToolInfo[];
}

/** Subscribes to the server's SSE stream. EventSource reconnects on its own; each reconnect resends a snapshot. */
export function useAgentStream() {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent<string>).data) as Snapshot;
      setSessions(new Map(data.sessions.map((s) => [s.key, s])));
      setTools(data.tools);
      setConnection("live");
    });
    source.addEventListener("upsert", (e) => {
      const session = JSON.parse((e as MessageEvent<string>).data) as Session;
      setSessions((prev) => new Map(prev).set(session.key, session));
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
    return () => source.close();
  }, []);

  return { sessions: [...sessions.values()], tools, connection };
}

export async function dismissSession(key: string): Promise<void> {
  await fetch("/api/sessions/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
}
