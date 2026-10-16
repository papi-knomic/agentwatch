import { randomBytes } from "node:crypto";
import { DEFAULT_PORT } from "./constants.js";
import { readTextIfExists, writeFileAtomic } from "./fs.js";
import { configPath } from "./paths.js";
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
  /** auto: open the project in VS Code if the session runs there, otherwise open the dashboard. */
  clickAction: ClickAction;
}

export interface Config {
  port: number;
  token: string;
  /** Master switch for desktop notifications. */
  notifications: boolean;
  /** Show each session's task name (the start of its first prompt). false: no prompt text is kept at all. */
  taskTitles?: boolean;
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
    tools: { ...toolDefaults },
  };
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized !== text) await writeFileAtomic(path, serialized);
  return config;
}
