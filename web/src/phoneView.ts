import type { PairedDevice, RemoteSettings, ServeOutcome } from "./remote";

/**
 * Pure view logic for the Phone tab. Everything the tab shows about phone access is derived here from the server's
 * answers, so the wizard and the advanced cards can never disagree (they used to keep separate copies).
 */

export type StepState = "done" | "current" | "blocked" | "todo";

export interface RemoteView {
  /** The server's switch (config.remote.enabled): the one source of truth for "phone access is on". */
  on: boolean;
  /** The Tailscale name phones use, without scheme. */
  host: string | null;
  /** `https://<host>` when on and the host is known. */
  address: string | null;
  paired: boolean;
  pairedNames: string[];
  /** On in the config but Tailscale reports no mapping: the user needs to press Re-apply. */
  mappingMissing: boolean;
}

export function remoteView(
  remote: RemoteSettings | null,
  serve: ServeOutcome | null,
  devices: PairedDevice[],
): RemoteView {
  const on = remote?.enabled === true;
  const host = remote?.hosts[0] ?? (on ? (serve?.host ?? null) : null);
  return {
    on,
    host,
    address: on && host ? `https://${host}` : null,
    paired: on && devices.length > 0,
    pairedNames: devices.map((d) => d.name),
    mappingMissing: on && serve?.state === "off",
  };
}

export function stepStates(view: RemoteView): [StepState, StepState, StepState] {
  if (!view.on) return ["current", "todo", "blocked"];
  if (view.paired) return ["done", "done", "done"];
  return ["done", "current", "current"];
}

/** The link the subscribe QR code and buttons use. https works in iOS's camera and Safari; ntfy:// does not. */
export function ntfySubscribeUrl(server: string, topic: string): string {
  return `${server.replace(/\/+$/, "")}/${topic}`;
}

/** The server as people say it: `ntfy.sh` for https://ntfy.sh. */
export function ntfyServerLabel(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function lastSeen(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString();
}

export function pairedSummary(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
