import type { Sound } from "../core/config.js";
import { runProcess } from "./run.js";
import type { DesktopNotification } from "./types.js";

const SOUND_NAMES: Record<Exclude<Sound, "silent">, string> = {
  default: "Glass",
  im: "Pop",
  mail: "Ping",
  reminder: "Purr",
  sms: "Tink",
  alarm: "Sosumi",
};

// Text is passed as argv to the AppleScript, never interpolated into it.
// Limitation: `display notification` cannot open a URL when clicked.
export async function notifyMacos(notification: DesktopNotification): Promise<void> {
  const soundClause =
    notification.sound === "silent" ? "" : ` sound name "${SOUND_NAMES[notification.sound]}"`;
  await runProcess("osascript", [
    "-e",
    "on run argv",
    "-e",
    `display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)${soundClause}`,
    "-e",
    "end run",
    notification.title,
    notification.body,
    notification.attribution ?? "",
  ]);
}
