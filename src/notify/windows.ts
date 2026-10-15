import type { Sound } from "../core/config.js";
import { runProcess } from "./run.js";
import type { DesktopNotification } from "./types.js";

// Toasts need a registered app id. Until we ship our own Start Menu shortcut, borrow PowerShell's,
// which is present on every Windows install (toasts show "Windows PowerShell" as the source).
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const SOUND_EVENTS: Record<Exclude<Sound, "silent">, string> = {
  default: "ms-winsoundevent:Notification.Default",
  im: "ms-winsoundevent:Notification.IM",
  mail: "ms-winsoundevent:Notification.Mail",
  reminder: "ms-winsoundevent:Notification.Reminder",
  sms: "ms-winsoundevent:Notification.SMS",
  alarm: "ms-winsoundevent:Notification.Looping.Alarm",
};

// The XML and app id travel in env vars, never spliced into the script, so no quoting/injection issues.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:AGENT_TOAST_XML)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:AGENT_TOAST_APP_ID).Show($toast)
`;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildToastXml(notification: DesktopNotification): string {
  const launch = notification.clickUrl
    ? ` activationType="protocol" launch="${escapeXml(notification.clickUrl)}"`
    : "";
  const audio =
    notification.sound === "silent"
      ? `<audio silent="true"/>`
      : `<audio src="${SOUND_EVENTS[notification.sound]}" loop="false"/>`;
  return [
    `<toast${launch}>`,
    `<visual><binding template="ToastGeneric">`,
    `<text>${escapeXml(notification.title)}</text>`,
    `<text>${escapeXml(notification.body)}</text>`,
    `</binding></visual>`,
    audio,
    `</toast>`,
  ].join("");
}

export async function notifyWindows(notification: DesktopNotification): Promise<void> {
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  // Windows PowerShell 5.1 (not pwsh) is required: it can load the WinRT toast APIs directly.
  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { AGENT_TOAST_XML: buildToastXml(notification), AGENT_TOAST_APP_ID: APP_ID },
  );
}
