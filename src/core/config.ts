import { randomBytes } from "node:crypto";
import { DEFAULT_PORT } from "./constants.js";
import { readTextIfExists, writeFileAtomic } from "./fs.js";
import { configPath } from "./paths.js";
import { defaultPhoneConfig, type PhoneConfig, parsePhone } from "./phone.js";
import { NOTIFIABLE_STATUSES, type NotifiableStatus } from "./types.js";

export const SOUNDS = ["default", "im", "mail", "reminder", "sms", "alarm", "silent"] as const;
export type Sound = (typeof SOUNDS)[number];

export const CLICK_ACTIONS = ["auto", "vscode", "dashboard", "none"] as const;
export type ClickAction = (typeof CLICK_ACTIONS)[number];

export interface ToolSettings {
  enabled: boolean;
  label: string;
  color: string;
  sound: Sound;
  notifyOn: Record<NotifiableStatus, boolean>;
  /** auto: open the session's app when supported, the VS Code project, or the dashboard as a fallback. */
  clickAction: ClickAction;
}

export interface RemoteConfig {
  enabled: boolean;
  /** Bare, lowercase hostnames such as mybox.tail1234.ts.net (no scheme, port or path). */
  hosts: string[];
}

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_REMOTE_HOSTS = 5;

/** A bare DNS name with at least two labels that is not an IP address. Returns it lowercased, or null. */
export function normalizeRemoteHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  // 127.0.0.1 and friends must never become a "remote" host.
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return null;
  return host;
}

export function parseRemote(value: unknown): RemoteConfig {
  if (!isRecord(value)) return { enabled: false, hosts: [] };
  const hosts = Array.isArray(value.hosts)
    ? [...new Set(value.hosts.map(normalizeRemoteHost).filter((h): h is string => h !== null))].slice(
        0,
        MAX_REMOTE_HOSTS,
      )
    : [];
  return { enabled: bool(value.enabled, false) && hosts.length > 0, hosts };
}

export interface Config {
  port: number;
  token: string;
  /** Master switch for desktop notifications. */
  notifications: boolean;
  /** Show each session's task name (the start of its first prompt). false: no prompt text is kept at all. */
  taskTitles?: boolean;
  /**
   * Opt-in: answer Claude Code permission prompts and questions from the dashboard. Needs the `decide` hooks
   * (`agentwatch install --tool claude-code --remote-actions`). Off by default.
   */
  remoteActions?: boolean;
  /**
   * Opt-in phone access through a user-run HTTPS proxy (Tailscale Serve). The server still listens on 127.0.0.1 only;
   * requests whose Host is one of `hosts` are "remote" and need a paired-device cookie. Off by default.
   */
  remote?: RemoteConfig;
  /** Opt-in push notifications to a phone through ntfy. Off by default. Follows `notifications` and the per-tool rules. */
  phone?: PhoneConfig;
  tools: Record<string, ToolSettings>;
}

export function defaultToolSettings(label: string, color: string, sound: Sound): ToolSettings {
  return {
    enabled: true,
    label,
    color,
    sound,
    notifyOn: { needs_input: true, done: true, error: true },
    clickAction: "auto",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Config is hand-edited by users, so every field falls back to its default instead of failing. */
function parseToolSettings(value: unknown, defaults: ToolSettings): ToolSettings {
  if (!isRecord(value)) return defaults;
  const notifyOn = isRecord(value.notifyOn) ? value.notifyOn : {};
  return {
    enabled: bool(value.enabled, defaults.enabled),
    label: typeof value.label === "string" && value.label.trim() !== "" ? value.label : defaults.label,
    color:
      typeof value.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.color)
        ? value.color
        : defaults.color,
    sound: pick(SOUNDS, value.sound, defaults.sound),
    notifyOn: Object.fromEntries(
      NOTIFIABLE_STATUSES.map((status) => [status, bool(notifyOn[status], defaults.notifyOn[status])]),
    ) as Record<NotifiableStatus, boolean>,
    clickAction: pick(CLICK_ACTIONS, value.clickAction, defaults.clickAction),
  };
}

export function parseConfig(value: unknown, toolDefaults: Record<string, ToolSettings>): Config | null {
  if (!isRecord(value)) return null;
  const token = typeof value.token === "string" && value.token.length >= 16 ? value.token : null;
  if (!token) return null;
  const port =
    typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port < 65536
      ? value.port
      : DEFAULT_PORT;
  const rawTools = isRecord(value.tools) ? value.tools : {};
  const tools: Record<string, ToolSettings> = {};
  for (const [id, defaults] of Object.entries(toolDefaults)) {
    tools[id] = parseToolSettings(rawTools[id], defaults);
  }
  return {
    port,
    token,
    notifications: bool(value.notifications, true),
    taskTitles: bool(value.taskTitles, true),
    remoteActions: bool(value.remoteActions, false),
    remote: parseRemote(value.remote),
    phone: parsePhone(value.phone),
    tools,
  };
}

/** Read-only: used by the hook, which must never create files. */
export async function readConfig(
  toolDefaults: Record<string, ToolSettings>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config | null> {
  const text = await readTextIfExists(configPath(env));
  if (text === null) return null;
  try {
    return parseConfig(JSON.parse(text), toolDefaults);
  } catch {
    return null;
  }
}

/** Saves a config that is already loaded, e.g. after the dashboard changed a setting. */
export async function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeFileAtomic(
    configPath(env),
    `${JSON.stringify(config, null, 2)}
`,
  );
}

// Every partial save is read-modify-write on the same file. Overlapping saves from the dashboard would each start
// from the same old text and the later rename would drop the earlier change, so they run one after another.
let saveQueue: Promise<unknown> = Promise.resolve();

function enqueueSave<T>(task: () => Promise<T>): Promise<T> {
  const run = saveQueue.then(task, task);
  saveQueue = run.catch(() => {});
  return run;
}

/** Whether the config file exists, so callers can tell "unchanged" from "nothing to change". */
export async function configFileExists(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await readTextIfExists(configPath(env))) !== null;
}

/**
 * Sets one key in the file on disk, leaving every other key as the file has it. The running server's in-memory
 * config can be stale (the file may have been edited, or changed by the CLI), so it must never be written back
 * wholesale for this. Returns whether the file changed; false too when there is no config file yet.
 */
function setConfigKey(
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
  skipIfSame: boolean,
): Promise<boolean> {
  return enqueueSave(async () => {
    const path = configPath(env);
    const text = await readTextIfExists(path);
    if (text === null) return false;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Could not parse ${path}. Fix or delete it, then try again.`);
    }
    if (!isRecord(raw)) throw new Error(`${path} is not a config file.`);
    if (skipIfSame && raw[key] === value) return false;
    await writeFileAtomic(path, `${JSON.stringify({ ...raw, [key]: value }, null, 2)}\n`);
    return true;
  });
}

/** Sets only `remoteActions` in the file on disk. Returns whether the file changed. */
export function setRemoteActionsFlag(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return setConfigKey("remoteActions", enabled, env, true);
}

/** Sets only `remote` in the file on disk. Returns false when there is no config file. */
export function setRemoteConfig(
  remote: RemoteConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return setConfigKey("remote", remote, env, false);
}

/** Sets only `phone` in the file on disk. Returns false when there is no config file. */
export function setPhoneConfig(phone: PhoneConfig, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return setConfigKey("phone", phone, env, false);
}

/**
 * Loads the config, creating it (with a fresh token) if missing, and writes back any tool
 * entries that are new so users can see and edit them.
 */
export async function ensureConfig(
  toolDefaults: Record<string, ToolSettings>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  const path = configPath(env);
  const text = await readTextIfExists(path);
  let raw: unknown = null;
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Could not parse ${path}. Fix or delete it, then try again.`);
    }
  }
  const existing = parseConfig(raw, toolDefaults);
  const config: Config = existing ?? {
    port: DEFAULT_PORT,
    token: randomBytes(24).toString("hex"),
    notifications: true,
    taskTitles: true,
    remoteActions: false,
    remote: { enabled: false, hosts: [] },
    phone: defaultPhoneConfig(),
    tools: { ...toolDefaults },
  };
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized !== text) await writeFileAtomic(path, serialized);
  return config;
}
