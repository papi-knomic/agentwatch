import { runProcess } from "./run.js";
import type { DesktopNotification } from "./types.js";

// Uses notify-send (libnotify). Sounds and click actions depend on the desktop environment and are not set.
export async function notifyLinux(notification: DesktopNotification): Promise<void> {
  await runProcess("notify-send", ["--app-name", "AI agents", notification.title, notification.body]);
}
