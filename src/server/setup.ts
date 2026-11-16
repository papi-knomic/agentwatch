import type { Adapter, InstallResult } from "../adapters/types.js";
import type { Config } from "../core/config.js";
import { APP_NAME } from "../core/constants.js";
import { type BackgroundHold, DEFAULT_BACKGROUND_HOLD } from "../core/decision-types.js";

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

/** Answering permission prompts and questions from the dashboard: opt-in, for tools that support it. */
export interface RemoteActionsState {
  supported: boolean;
  /** The config flag: the server accepts decisions. */
  enabled: boolean;
  /** The `decide` hooks are in the tool's config. Both must be true for it to work. */
  installed: boolean;
  /** Tools that have it, by display name. */
  tools: string[];
  /** What blocking terminal prompts do while the dashboard is only open in the background. */
  backgroundHold: BackgroundHold;
}

export interface SetupState {
  cli: string;
  autostart: { supported: boolean; installed: boolean };
  /** Applies to every tool. */
  notes: string[];
  tools: ToolSetup[];
  remoteActions: RemoteActionsState;
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
  /** Turns remote actions on (adds the `decide` hooks and the config flag) or off (removes both). */
  setRemoteActions(
    enabled: boolean,
    dryRun: boolean,
  ): Promise<{ results: ConnectResult[]; setup: SetupState }>;
  /** Saves and applies the background-hold mode (no hooks change). */
  setBackgroundHold(mode: BackgroundHold): Promise<SetupState>;
}

export interface SetupDeps {
  adapters: readonly Adapter[];
  config: Config;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  hookCommandFor: (toolId: string) => string;
  decideCommandFor?: (toolId: string) => string;
  /** Persists the remote actions flag (and nothing else) after it is switched. */
  saveRemoteActions?: (enabled: boolean) => Promise<void>;
  /** Persists the background-hold mode (and nothing else). */
  saveBackgroundHold?: (mode: BackgroundHold) => Promise<void>;
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
    ...(deps.decideCommandFor ? { decideCommand: deps.decideCommandFor(adapter.meta.id) } : {}),
  });
  /**
   * Tools that get the decide hooks. Only ones already connected, so switching the feature on never writes a tool's
   * config (e.g. ~/.codex/hooks.json) for someone who doesn't use it. With nothing connected yet, all of them.
   */
  const remoteTools = async () => {
    const capable = deps.adapters.filter((a) => a.meta.remoteActions && deps.decideCommandFor);
    const connected = await Promise.all(
      capable.map((a) =>
        a
          .install(optionsFor(a, true))
          .then((r) => !r.changed)
          .catch(() => false),
      ),
    );
    const used = capable.filter((_, i) => connected[i]);
    return used.length > 0 ? used : capable;
  };

  async function remoteActionsState(): Promise<RemoteActionsState> {
    const tools = await remoteTools();
    // Installed = adding the hooks would change nothing.
    const previews = await Promise.all(
      tools.map((a) =>
        a
          .install({ ...optionsFor(a, true), remoteActions: true })
          .then((r) => !r.changed)
          .catch(() => false),
      ),
    );
    return {
      supported: tools.length > 0 && deps.saveRemoteActions !== undefined,
      enabled: deps.config.remoteActions === true,
      installed: previews.length > 0 && previews.every(Boolean),
      tools: tools.map((a) => a.meta.displayName),
      backgroundHold: deps.config.remoteActionsBackgroundHold ?? DEFAULT_BACKGROUND_HOLD,
    };
  }

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
      remoteActions: await remoteActionsState(),
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

  async function setRemoteActions(enabled: boolean, dryRun: boolean) {
    const targets = await remoteTools();
    if (targets.length === 0 || !deps.saveRemoteActions)
      throw new UnknownToolError("Remote actions aren't available");
    const results: ConnectResult[] = [];
    for (const adapter of targets) {
      const result = await adapter.install({ ...optionsFor(adapter, dryRun), remoteActions: enabled });
      results.push({
        id: adapter.meta.id,
        configPath: result.configPath,
        changed: result.changed,
        summary: result.summary,
        ...(result.backupPath ? { backupPath: result.backupPath } : {}),
        afterInstall: adapter.meta.afterInstall ?? [],
      });
    }
    // Hooks first: if they can't be written, the flag must not claim the feature is on.
    if (!dryRun) {
      await deps.saveRemoteActions(enabled);
      deps.config.remoteActions = enabled;
    }
    return { results, setup: await status() };
  }

  async function setBackgroundHold(mode: BackgroundHold) {
    if (!deps.saveBackgroundHold) throw new UnknownToolError("This setting isn't available");
    await deps.saveBackgroundHold(mode);
    deps.config.remoteActionsBackgroundHold = mode;
    return status();
  }

  return { status, connect, setRemoteActions, setBackgroundHold };
}
