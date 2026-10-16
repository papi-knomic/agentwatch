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

export function useSetup(): { setup: SetupState; replace: (setup: Setup) => void } {
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
    void load();
    // Hooks can be installed from a terminal too; refresh when the user comes back to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

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
