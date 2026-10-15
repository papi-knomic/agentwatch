import type { Sound } from "../core/config.js";

export interface DesktopNotification {
  title: string;
  body: string;
  sound: Sound;
  /** Opened when the notification is clicked, where the platform supports it. */
  clickUrl?: string;
}

export type Notifier = (notification: DesktopNotification) => Promise<void>;
