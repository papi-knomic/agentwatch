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
  /** Something of ours is installed but out of date (the CLI moved, or an older version wrote it): connecting again updates it. */
  outdated?: boolean;
}

/** Answering permission prompts and questions from the dashboard: opt-in, for tools that support it. */
export interface RemoteToolState {
  id: string;
  name: string;
  connected: boolean;
  /** "on" = this tool's decide hook/plugin is installed. A tool left "off" on purpose is a normal state. */
  answering: "on" | "off";
  /** Why it can't be switched, or a hint (config unreadable, installed but out of date). */
  note?: string;
}

export interface RemoteActionsState {
  supported: boolean;
  /** The config flag: the server accepts decisions. */
  enabled: boolean;
  /** The `decide` hooks are in the tool's config. Both must be true for it to work. */
  installed: boolean;
  /** Tools that have it, by display name. */
  tools: string[];
  /** Every remote-capable tool, connected or not. */
  perTool: RemoteToolState[];
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
  /**
   * Turns answering on or off for one tool only (additive, backed up, idempotent) and keeps the master flag in step:
   * on while any tool still has it.
   */
  setToolRemoteActions(
    tool: string,
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

  /** The decide hook/plugin is installed: adding it would change nothing. */
  const answeringOn = (a: Adapter) =>
    a
      .install({ ...optionsFor(a, true), remoteActions: true })
      .then((r) => !r.changed)
      .catch(() => false);

  async function remoteActionsState(setups: ToolSetup[]): Promise<RemoteActionsState> {
    const tools = await remoteTools();
    const capable = deps.adapters.filter((a) => a.meta.remoteActions && deps.decideCommandFor);
    const previews = await Promise.all(tools.map(answeringOn));
    const perTool = await Promise.all(
      capable.map(async (a): Promise<RemoteToolState> => {
        const setup = setups.find((t) => t.id === a.meta.id);
        const on = await answeringOn(a);
        const note = setup?.error
          ? "Can't read its config"
          : setup?.outdated
            ? "Installed but out of date: connect it again to update"
            : undefined;
        return {
          id: a.meta.id,
          name: a.meta.displayName,
          connected: setup?.connected ?? false,
          answering: on ? "on" : "off",
          ...(note ? { note } : {}),
        };
      }),
    );
    return {
      supported: tools.length > 0 && deps.saveRemoteActions !== undefined,
      enabled: deps.config.remoteActions === true,
      installed: previews.length > 0 && previews.every(Boolean),
      tools: tools.map((a) => a.meta.displayName),
      perTool,
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
      if (preview.changed) {
        // Something of ours already there (an uninstall would remove it) means "installed but stale", not "absent".
        const present = await adapter
          .uninstall(optionsFor(adapter, true))
          .then((r) => r.changed)
          .catch(() => false);
        return {
          ...base,
          connected: false,
          configPath: preview.configPath,
          ...(present ? { outdated: true } : {}),
        };
      }
      return { ...base, connected: true, configPath: preview.configPath };
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
    const tools = await Promise.all(deps.adapters.map(toolSetup));
    return {
      cli: APP_NAME,
      autostart: { supported: autostart !== undefined, installed: autostart ? await autostart() : false },
      notes: GENERAL_NOTES,
      tools,
      remoteActions: await remoteActionsState(tools),
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

  async function setToolRemoteActions(tool: string, enabled: boolean, dryRun: boolean) {
    const adapter = deps.adapters.find((a) => a.meta.id === tool);
    if (!adapter) throw new UnknownToolError(`Unknown tool "${tool}"`);
    if (!adapter.meta.remoteActions || !deps.decideCommandFor || !deps.saveRemoteActions)
      throw new UnknownToolError(
        `Answering from the dashboard isn't available for ${adapter.meta.displayName}`,
      );
    if (enabled) {
      // Installing the decide entry writes the tool's whole hook set, so only for a tool the user already connected.
      const current = await toolSetup(adapter);
      if (!current.connected) throw new UnknownToolError(`Connect ${adapter.meta.displayName} first`);
    }
    const result = await adapter.install({ ...optionsFor(adapter, dryRun), remoteActions: enabled });
    const results: ConnectResult[] = [
      {
        id: adapter.meta.id,
        configPath: result.configPath,
        changed: result.changed,
        summary: result.summary,
        ...(result.backupPath ? { backupPath: result.backupPath } : {}),
        afterInstall: adapter.meta.afterInstall ?? [],
      },
    ];
    if (!dryRun) {
      // The flag is the master switch: on while any tool still answers (same rule as `install --tool`).
      const others = deps.adapters.filter((a) => a !== adapter && a.meta.remoteActions);
      const othersOn = (await Promise.all(others.map(answeringOn))).some(Boolean);
      const flag = enabled || othersOn;
      await deps.saveRemoteActions(flag);
      deps.config.remoteActions = flag;
    }
    return { results, setup: await status() };
  }

  async function setBackgroundHold(mode: BackgroundHold) {
    if (!deps.saveBackgroundHold) throw new UnknownToolError("This setting isn't available");
    await deps.saveBackgroundHold(mode);
    deps.config.remoteActionsBackgroundHold = mode;
    return status();
  }

  return { status, connect, setRemoteActions, setToolRemoteActions, setBackgroundHold };
}
