import { notifyLinux } from "./linux.js";
import { notifyMacos } from "./macos.js";
import type { Notifier } from "./types.js";
import { notifyWindows } from "./windows.js";

export type { DesktopNotification, Notifier } from "./types.js";

export function createNotifier(platform: NodeJS.Platform = process.platform): Notifier {
  switch (platform) {
    case "win32":
      return notifyWindows;
    case "darwin":
      return notifyMacos;
    default:
      return notifyLinux;
  }
}
