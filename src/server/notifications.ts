import type { Config, ToolSettings } from "../core/config.js";
import type { StoreChange } from "../core/store.js";
import { NOTIFIABLE_STATUSES, type NotifiableStatus, type Session } from "../core/types.js";
import type { DesktopNotification, Notifier } from "../notify/index.js";

/** Same session + same status within this window is treated as a duplicate. */
const DEDUPE_MS = 3000;

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

export function vscodeUrl(cwd: string): string {
  let path = cwd.replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return `vscode://file${encodeURI(path)}`;
}

function isNotifiable(status: string): status is NotifiableStatus {
  return (NOTIFIABLE_STATUSES as readonly string[]).includes(status);
}

function bodyFor(status: NotifiableStatus, session: Session): string {
  switch (status) {
    case "needs_input":
      return session.message ?? "Needs your input";
    case "done":
      return "Finished. Ready for your next prompt.";
    case "error":
      return session.message ? `Stopped with an error: ${session.message}` : "Stopped with an error";
  }
}

function clickUrlFor(settings: ToolSettings, session: Session, dashboardUrl: string): string | undefined {
  switch (settings.clickAction) {
    case "none":
      return undefined;
    case "dashboard":
      return dashboardUrl;
    case "vscode":
      return vscodeUrl(session.cwd);
    case "auto":
      return session.host?.startsWith("VS Code") ? vscodeUrl(session.cwd) : dashboardUrl;
  }
}

export function buildNotification(
  session: Session,
  status: NotifiableStatus,
  settings: ToolSettings,
  dashboardUrl: string,
): DesktopNotification {
  const notification: DesktopNotification = {
    title: `${settings.label} · ${projectName(session.cwd)}`,
    body: bodyFor(status, session),
    sound: settings.sound,
  };
  const clickUrl = clickUrlFor(settings, session, dashboardUrl);
  if (clickUrl) notification.clickUrl = clickUrl;
  return notification;
}

export function createNotificationDispatcher(options: {
  config: Config;
  notifier: Notifier;
  dashboardUrl: string;
  log: (message: string) => void;
  now?: () => number;
}): (change: StoreChange) => void {
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();

  return (change) => {
    if (change.type !== "upsert" || !options.config.notifications) return;
    const { session, previousStatus } = change;
    if (!isNotifiable(session.status) || session.status === previousStatus) return;

    const settings = options.config.tools[session.tool];
    if (!settings?.enabled || !settings.notifyOn[session.status]) return;

    const dedupeKey = `${session.key}:${session.status}`;
    const last = lastSent.get(dedupeKey);
    if (last !== undefined && now() - last < DEDUPE_MS) return;
    lastSent.set(dedupeKey, now());

    const notification = buildNotification(session, session.status, settings, options.dashboardUrl);
    options.notifier(notification).catch((error: unknown) => {
      options.log(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}
