import { randomBytes } from "node:crypto";

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TOKEN_LENGTH = 256;

/** Opt-in push notifications to a phone through an ntfy server (https://docs.ntfy.sh). Off by default. */
export interface PhoneConfig {
  enabled: boolean;
  /** Base URL of the ntfy server. https only (plain http just for this computer, e.g. a local test server). */
  server: string;
  /** On the public ntfy.sh anyone who knows the topic can read it, so it is the secret: random and long. */
  topic: string;
  /** Optional access token for a protected server. Never sent to the browser. */
  token?: string;
  /** Add the project folder name, task title and the agent's message. Off: generic text only. */
  includeDetails: boolean;
}

export function defaultPhoneConfig(): PhoneConfig {
  return { enabled: false, server: DEFAULT_NTFY_SERVER, topic: "", includeDetails: false };
}

/** 192 bits, base64url: 32 characters of [A-Za-z0-9_-], which also satisfies the topic pattern. */
export function generateTopic(): string {
  return randomBytes(24).toString("base64url");
}

export function isValidTopic(value: unknown): value is string {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

/**
 * Returns the normalized server URL (no trailing slash, no credentials, query or fragment), or null.
 * Requires https because the topic (and token) travel in the request; plain http is allowed only for localhost,
 * where nothing leaves the machine. Private-LAN and .ts.net addresses are not special-cased: use https there too.
 */
export function normalizeServer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Config is hand-edited: anything invalid falls back to defaults and leaves the feature off. */
export function parsePhone(value: unknown): PhoneConfig {
  const defaults = defaultPhoneConfig();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
  const raw = value as Record<string, unknown>;
  const server = normalizeServer(raw.server) ?? defaults.server;
  const topic = isValidTopic(raw.topic) ? raw.topic : "";
  const token =
    typeof raw.token === "string" && raw.token.trim() !== "" && raw.token.length <= MAX_TOKEN_LENGTH
      ? raw.token.trim()
      : undefined;
  const wasEnabled = raw.enabled === true;
  return {
    // Without a valid topic there is nowhere to send to.
    enabled: wasEnabled && topic !== "",
    server,
    topic,
    ...(token ? { token } : {}),
    includeDetails: raw.includeDetails === true,
  };
}

export interface PhoneUpdate {
  enabled?: unknown;
  server?: unknown;
  /** undefined keeps the current token; "" clears it. */
  token?: unknown;
  includeDetails?: unknown;
  /** true: replace the topic with a fresh random one. */
  regenerateTopic?: unknown;
}

/** Applies a change from the dashboard to the current settings. Throws a user-readable Error on bad input. */
export function applyPhoneUpdate(current: PhoneConfig, update: PhoneUpdate): PhoneConfig {
  const next: PhoneConfig = { ...current };
  if (update.server !== undefined) {
    const server = normalizeServer(update.server);
    if (!server)
      throw new Error("The server must be an https:// URL (http:// is only allowed for localhost).");
    next.server = server;
  }
  if (update.token !== undefined) {
    if (typeof update.token !== "string" || update.token.length > MAX_TOKEN_LENGTH)
      throw new Error("Invalid access token.");
    const token = update.token.trim();
    if (token) next.token = token;
    else delete next.token;
  }
  if (update.includeDetails !== undefined) {
    if (typeof update.includeDetails !== "boolean") throw new Error("includeDetails must be true or false.");
    next.includeDetails = update.includeDetails;
  }
  if (update.regenerateTopic === true) next.topic = generateTopic();
  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "boolean") throw new Error("enabled must be true or false.");
    next.enabled = update.enabled;
  }
  if (next.enabled && !isValidTopic(next.topic)) next.topic = generateTopic();
  return next;
}

/** What the browser may see: everything except the token. */
export function publicPhone(phone: PhoneConfig): Omit<PhoneConfig, "token"> & { tokenSet: boolean } {
  const { token, ...rest } = phone;
  return { ...rest, tokenSet: token !== undefined };
}
