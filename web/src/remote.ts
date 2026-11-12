import { useCallback, useEffect, useState } from "react";

/** Who is looking: this PC's own dashboard, or a paired phone reaching it through an HTTPS proxy. */
export type Me = { remote: false } | { remote: true; device: { name: string; allowApprovals: boolean } };

export type MeState =
  | { kind: "loading" }
  | { kind: "ready"; me: Me }
  /** A remote request was refused with 401: the cookie is missing, revoked or never issued. */
  | { kind: "unpaired" }
  | { kind: "error" };

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : `Request failed (${res.status})`;
}

export function useMe(): { state: MeState; reload: () => void; markUnpaired: () => void } {
  const [state, setState] = useState<MeState>({ kind: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    // Re-runs on reload(); `round` only exists to trigger that.
    void round;
    let cancelled = false;
    fetch("/api/me")
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) setState({ kind: "unpaired" });
        else if (res.ok) setState({ kind: "ready", me: (await res.json()) as Me });
        else setState({ kind: "error" });
      })
      .catch(() => !cancelled && setState({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [round]);

  return {
    state,
    reload: useCallback(() => setRound((n) => n + 1), []),
    markUnpaired: useCallback(() => setState({ kind: "unpaired" }), []),
  };
}

/** The pairing code from a scanned QR code (`#pair=<code>`), if any. */
export function pairCodeFromHash(): string | null {
  const code = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("pair");
  return code && /^[A-Za-z0-9_-]{8,128}$/.test(code) ? code : null;
}

export function clearHash(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/** A short, friendly default for the device name, from the user agent. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) {
    const model = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|[;)])/.exec(ua)?.[1]?.trim();
    return model && model.length <= 30 ? model : "Android phone";
  }
  return "Browser";
}

export async function pairDevice(
  code: string,
  name: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 429) {
      return { ok: false, message: "Too many attempts — make a new code on your PC" };
    }
    return { ok: false, message: await readError(res) };
  } catch {
    return { ok: false, message: "Couldn't reach AgentWatch. Check that Tailscale Serve is running." };
  }
}

/** While the dashboard is reconnecting, finds out whether the cause is a revoked pairing. */
export function useUnpairedWatch(active: boolean, onUnpaired: () => void): void {
  useEffect(() => {
    if (!active) return;
    const check = () => {
      fetch("/api/me")
        .then((res) => res.status === 401 && onUnpaired())
        .catch(() => {});
    };
    check();
    const id = window.setInterval(check, 5000);
    return () => window.clearInterval(id);
  }, [active, onUnpaired]);
}

// Settings on this PC's dashboard (loopback only on the server).

export interface RemoteSettings {
  enabled: boolean;
  hosts: string[];
  port: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  allowApprovals: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

export const getRemoteSettings = () => call<RemoteSettings>("GET", "/api/setup/remote");
export const saveRemoteSettings = (enabled: boolean, hosts: string[]) =>
  call<RemoteSettings>("POST", "/api/setup/remote", { enabled, hosts });
export const detectRemoteHost = () => call<{ host: string | null }>("POST", "/api/setup/remote/detect");
export const createPairCode = () =>
  call<{ code: string; expiresAt: string }>("POST", "/api/devices/pair-code");
export const listDevices = async () =>
  (await call<{ devices: PairedDevice[] }>("GET", "/api/devices")).devices;
export const updateDevice = (id: string, patch: { name?: string; allowApprovals?: boolean }) =>
  call<{ device: PairedDevice }>("POST", `/api/devices/${encodeURIComponent(id)}`, patch);
export const revokeDevice = (id: string) =>
  call<{ ok: true }>("DELETE", `/api/devices/${encodeURIComponent(id)}`);
