import { useCallback, useEffect, useState } from "react";

export interface SetupTool {
  id: string;
  label: string;
  color: string;
  /** Hooks installed and up to date. */
  connected: boolean;
  configPath: string;
  /** The same install as a terminal command, for people who prefer that. */
  command: string;
  /** Steps left to do in the tool itself, e.g. approving new hooks. */
  afterInstall: string[];
  /** Set when the tool's config can't be read (e.g. invalid JSON); connecting would fail. */
  error?: string;
}

export interface Setup {
  cli: string;
  autostart: { supported: boolean; installed: boolean };
  /** General steps that apply to every tool. */
  notes: string[];
  tools: SetupTool[];
  remoteActions: { supported: boolean; enabled: boolean; installed: boolean; tools: string[] };
}

export interface ConnectResult {
  id: string;
  configPath: string;
  changed: boolean;
  summary: string[];
  backupPath?: string;
  afterInstall: string[];
}

/** null while loading; "unavailable" when the server has no setup endpoint (older server). */
export type SetupState = Setup | null | "unavailable";

/** `enabled` is false on a paired phone, which may not read the setup state (the server refuses it). */
export function useSetup(enabled = true): { setup: SetupState; replace: (setup: Setup) => void } {
  const [setup, setSetup] = useState<SetupState>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/setup");
      setSetup(res.ok ? ((await res.json()) as Setup) : "unavailable");
    } catch {
      setSetup("unavailable");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    // Hooks can be installed from a terminal too; refresh when the user comes back to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load, enabled]);

  return { setup, replace: setSetup };
}

export async function connectTool(
  tool: string,
  dryRun: boolean,
): Promise<{ results: ConnectResult[]; setup: Setup }> {
  const res = await fetch("/api/setup/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, dryRun }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return (await res.json()) as { results: ConnectResult[]; setup: Setup };
}

export async function setRemoteActions(
  enabled: boolean,
  dryRun: boolean,
): Promise<{ results: ConnectResult[]; setup: Setup }> {
  const res = await fetch("/api/setup/remote-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, dryRun }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return (await res.json()) as { results: ConnectResult[]; setup: Setup };
}

/** What the server tells the browser about phone (ntfy) notifications. The access token itself is never sent. */
export interface PhoneSettings {
  enabled: boolean;
  server: string;
  topic: string;
  includeDetails: boolean;
  tokenSet: boolean;
}

export interface PhoneUpdate {
  enabled?: boolean;
  server?: string;
  /** Omit to keep the current token; "" clears it. */
  token?: string;
  includeDetails?: boolean;
  regenerateTopic?: boolean;
}

async function phoneRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const getPhone = () => phoneRequest<PhoneSettings>("/api/setup/phone");

export const savePhone = (update: PhoneUpdate) =>
  phoneRequest<PhoneSettings>("/api/setup/phone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });

export const testPhone = () =>
  phoneRequest<{ ok: boolean; error?: string }>("/api/setup/phone/test", { method: "POST" });
