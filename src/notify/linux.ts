import { join } from "node:path";
import { appHome } from "../core/paths.js";
import { ensureStatusIcon } from "./icon.js";
import { runProcess } from "./run.js";
import type { DesktopNotification } from "./types.js";

// Uses notify-send (libnotify). Sounds and click actions depend on the desktop environment and are not set.
export async function notifyLinux(notification: DesktopNotification): Promise<void> {
  const body = notification.attribution
    ? `${notification.body}\n${notification.attribution}`
    : notification.body;
  const args = ["--app-name", "AI agents"];
  try {
    args.push(
      "--icon",
      await ensureStatusIcon(join(appHome(), "icons"), notification.color, notification.status),
    );
  } catch {
    // Fall back to the desktop's default icon.
  }
  await runProcess("notify-send", [...args, notification.title, body]);
}
