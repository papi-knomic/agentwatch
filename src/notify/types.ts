import type { Sound } from "../core/config.js";
import type { NotifiableStatus } from "../core/types.js";

export interface NotificationAction {
  label: string;
  url: string;
}

export interface DesktopNotification {
  title: string;
  body: string;
  /** Small secondary line, e.g. "Claude Code · VS Code". */
  attribution?: string;
  sound: Sound;
  /** Drives the icon: a circle in `color` with a status glyph. */
  status: NotifiableStatus;
  color: string;
  /** Opened when the notification is clicked, where the platform supports it. */
  clickUrl?: string;
  /** Buttons, where the platform supports them. */
  actions?: NotificationAction[];
}

export type Notifier = (notification: DesktopNotification) => Promise<void>;
