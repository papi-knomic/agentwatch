import type { Adapter, InstallResult } from "../adapters/types.js";
import type { Config } from "../core/config.js";
import { APP_NAME } from "../core/constants.js";

/** Whether each tool is connected, and how to connect it: shown on the landing page and by `status`. */

export interface ToolSetup {
  id: string;
  label: string;
  color: string;
  /** Hooks installed and up to date: a dry-run install would change nothing. */
  connected: boolean;
  configPath: string;
  /** For people who prefer the terminal. */
  command: string;
  /** Manual steps left after installing, e.g. trusting the hooks inside the tool. */
  afterInstall: string[];
  /** Set when the tool's config couldn't be read (e.g. invalid JSON); the tool can't be connected until fixed. */
  error?: string;
}

export interface SetupState {
  cli: string;
  autostart: { supported: boolean; installed: boolean };
  /** Applies to every tool. */
  notes: string[];
  tools: ToolSetup[];
}

export interface ConnectResult {
  id: string;
  configPath: string;
  changed: boolean;
  summary: string[];
  backupPath?: string;
  afterInstall: string[];
}

export interface SetupService {
  status(): Promise<SetupState>;
  connect(tool: string, dryRun: boolean): Promise<{ results: ConnectResult[]; setup: SetupState }>;
}

export interface SetupDeps {
  adapters: readonly Adapter[];
  config: Config;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  hookCommandFor: (toolId: string) => string;
  autostartInstalled?: () => Promise<boolean>;
  /** Extra one-time setup shared by all tools (e.g. the Windows notification identity). */
  afterConnect?: (dryRun: boolean) => Promise<void>;
}

export const GENERAL_NOTES = [
  "Start a new agent session after connecting: sessions that are already open don't pick up new hooks.",
];

export class UnknownToolError extends Error {}

export function createSetupService(deps: SetupDeps): SetupService {
  const optionsFor = (adapter: Adapter, dryRun: boolean) => ({
    homeDir: deps.homeDir,
    env: deps.env,
    dryRun,
    hookCommand: deps.hookCommandFor(adapter.meta.id),
  });

  async function toolSetup(adapter: Adapter): Promise<ToolSetup> {
    const { meta } = adapter;
    const settings = deps.config.tools[meta.id];
    const base = {
      id: meta.id,
      label: settings?.label ?? meta.displayName,
      color: settings?.color ?? meta.color,
      command: `${APP_NAME} install --tool ${meta.id}`,
      afterInstall: meta.afterInstall ?? [],
    };
    try {
      const preview = await adapter.install(optionsFor(adapter, true));
      return { ...base, connected: !preview.changed, configPath: preview.configPath };
    } catch (error) {
      return {
        ...base,
        connected: false,
        configPath: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function status(): Promise<SetupState> {
    const autostart = deps.autostartInstalled;
    return {
      cli: APP_NAME,
      autostart: { supported: autostart !== undefined, installed: autostart ? await autostart() : false },
      notes: GENERAL_NOTES,
      tools: await Promise.all(deps.adapters.map(toolSetup)),
    };
  }

  async function connect(tool: string, dryRun: boolean) {
    const targets = tool === "all" ? deps.adapters : deps.adapters.filter((a) => a.meta.id === tool);
    if (targets.length === 0) throw new UnknownToolError(`Unknown tool "${tool}"`);
    const results: ConnectResult[] = [];
    for (const adapter of targets) {
      const result: InstallResult = await adapter.install(optionsFor(adapter, dryRun));
      results.push({
        id: adapter.meta.id,
        configPath: result.configPath,
        changed: result.changed,
        summary: result.summary,
        ...(result.backupPath ? { backupPath: result.backupPath } : {}),
        afterInstall: adapter.meta.afterInstall ?? [],
      });
    }
    await deps.afterConnect?.(dryRun);
    return { results, setup: await status() };
  }

  return { status, connect };
}
