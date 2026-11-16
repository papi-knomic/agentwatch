import type { RemoteConfig } from "../core/config.js";
import { APP_DISPLAY_NAME } from "../core/constants.js";
import type { PhoneConfig } from "../core/phone.js";
import type { NotifiableStatus, Session } from "../core/types.js";

/** Publish API: https://docs.ntfy.sh/publish/ (Title, Priority, Tags, Click, Actions headers; Bearer auth). */

const REQUEST_TIMEOUT_MS = 5000;
/** Same session: at most one push per this window, and never two requests at once. */
const SESSION_MIN_INTERVAL_MS = 10_000;
const MAX_PER_MINUTE = 30;
const MAX_BODY_CHARS = 500;

export interface NtfyMessage {
  title: string;
  body: string;
  priority: "high" | "default";
  tags: string[];
  /** Opened when the notification is tapped. Only set when the dashboard is reachable from a phone. */
  click?: string;
}

export interface PublishResult {
  ok: boolean;
  /** Short, safe to show to the user and to log: never contains the topic or the token. */
  error?: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

const MESSAGES: Record<NotifiableStatus, string> = {
  needs_input: "Needs your input",
  done: "Finished",
  error: "Error",
};

const TAGS: Record<NotifiableStatus, string[]> = {
  needs_input: ["bell"],
  done: ["white_check_mark"],
  error: ["rotating_light"],
};

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The dashboard is only worth linking when the phone can reach it: through the configured remote host. */
export function phoneClickUrl(
  remote: Pick<RemoteConfig, "enabled" | "hosts"> | undefined,
): string | undefined {
  const host = remote?.enabled ? remote.hosts[0] : undefined;
  return host ? `https://${host}/` : undefined;
}

/**
 * Generic by default. Details (folder name only, never the full path; task title; the agent's short message) are
 * opt-in because a public ntfy server and the phone vendor's push service can see the text.
 */
export function buildPhoneMessage(
  session: Session,
  status: NotifiableStatus,
  toolLabel: string,
  phone: Pick<PhoneConfig, "includeDetails">,
  remote?: Pick<RemoteConfig, "enabled" | "hosts">,
): NtfyMessage {
  const lines = [MESSAGES[status]];
  if (phone.includeDetails) {
    const folder = folderName(session.cwd);
    if (folder) lines.push(folder);
    if (session.title) lines.push(session.title);
    if (session.message) lines.push(session.message);
  }
  const click = phoneClickUrl(remote);
  return {
    title: toolLabel,
    body: lines.join("\n").slice(0, MAX_BODY_CHARS),
    priority: status === "needs_input" ? "high" : "default",
    tags: TAGS[status],
    ...(click ? { click } : {}),
  };
}

/** Node refuses header values outside Latin-1, and users may rename a tool; RFC 2047 is what ntfy documents. */
function headerSafe(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function publishUrl(phone: Pick<PhoneConfig, "server" | "topic">): string {
  return `${phone.server.replace(/\/+$/, "")}/${phone.topic}`;
}

export function buildHeaders(message: NtfyMessage, token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Title: headerSafe(message.title),
    Priority: message.priority,
    Tags: message.tags.join(","),
  };
  if (message.click) {
    headers.Click = message.click;
    headers.Actions = `view, Open dashboard, ${message.click}`;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Never throws. The error text is a status code or a generic reason, because fetch errors can echo the URL. */
export async function publish(
  phone: PhoneConfig,
  message: NtfyMessage,
  fetchImpl: FetchLike = fetch,
): Promise<PublishResult> {
  try {
    const res = await fetchImpl(publishUrl(phone), {
      method: "POST",
      headers: buildHeaders(message, phone.token),
      body: message.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    return res.ok ? { ok: true } : { ok: false, error: `The ntfy server answered HTTP ${res.status}` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      error: timedOut ? "The ntfy server did not answer in time" : "Could not reach the ntfy server",
    };
  }
}

export interface PhoneNotifier {
  /** Fire and forget: returns immediately; failures are logged in one line and dropped. */
  notify(session: Session, status: NotifiableStatus, toolLabel: string): void;
  /** For the "Send test" button and `notify-test --phone`: reports the outcome and skips the rate limits. */
  sendTest(): Promise<PublishResult>;
}

export function createPhoneNotifier(options: {
  /** Read on every call so changes made in the dashboard apply without a restart. */
  getPhone: () => PhoneConfig | undefined;
  getRemote?: () => RemoteConfig | undefined;
  log: (message: string) => void;
  fetchImpl?: FetchLike;
  now?: () => number;
}): PhoneNotifier {
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();
  const inFlight = new Set<string>();
  let recent: number[] = [];

  return {
    notify(session, status, toolLabel) {
      const phone = options.getPhone();
      if (!phone?.enabled || !phone.topic) return;
      const t = now();
      const last = lastSent.get(session.key);
      if (inFlight.has(session.key) || (last !== undefined && t - last < SESSION_MIN_INTERVAL_MS)) return;
      recent = recent.filter((time) => t - time < 60_000);
      if (recent.length >= MAX_PER_MINUTE) return;
      recent.push(t);
      lastSent.set(session.key, t);
      inFlight.add(session.key);
      const message = buildPhoneMessage(session, status, toolLabel, phone, options.getRemote?.());
      publish(phone, message, options.fetchImpl)
        .then((result) => {
          if (!result.ok) options.log(`Phone notification failed: ${result.error}`);
        })
        .catch(() => undefined)
        .finally(() => inFlight.delete(session.key));
    },

    async sendTest() {
      const phone = options.getPhone();
      if (!phone?.topic) return { ok: false, error: "Phone notifications aren't set up yet" };
      const click = phoneClickUrl(options.getRemote?.());
      return publish(
        phone,
        {
          title: APP_DISPLAY_NAME,
          body: "Test notification. Phone notifications are working.",
          priority: "default",
          tags: ["white_check_mark"],
          ...(click ? { click } : {}),
        },
        options.fetchImpl,
      );
    },
  };
}
