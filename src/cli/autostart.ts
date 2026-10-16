import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APP_NAME } from "../core/constants.js";
import { readTextIfExists } from "../core/fs.js";

/**
 * Starts the server when the user logs in. Per-user only, no admin rights:
 * - Windows: a value in HKCU\...\Run, launched through `conhost --headless` so no console window flashes
 * - macOS: a LaunchAgent in ~/Library/LaunchAgents
 * - Linux: an XDG autostart entry in ~/.config/autostart (desktop sessions, which notifications need anyway)
 */

export interface AutostartTarget {
  nodePath: string;
  cliPath: string;
  homeDir: string;
}

export interface AutostartChange {
  location: string;
  changed: boolean;
}

export interface Autostart {
  location: string;
  /** What will run at login, for display. */
  command: string;
  isInstalled(): Promise<boolean>;
  install(dryRun: boolean): Promise<AutostartChange>;
  uninstall(dryRun: boolean): Promise<AutostartChange>;
}

const START_ARGS = ["start", "--background"];
export const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const LAUNCHD_LABEL = `dev.${APP_NAME}.server`;

// ---------- Windows ----------

export function windowsRunCommand(target: AutostartTarget, systemRoot: string): string {
  const conhost = join(systemRoot, "System32", "conhost.exe");
  return [`"${conhost}"`, "--headless", `"${target.nodePath}"`, `"${target.cliPath}"`, ...START_ARGS].join(
    " ",
  );
}

function powershell(script: string, env: Record<string, string>): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, ...env } },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

// Name and value travel in env vars, never spliced into the script.
const READ_RUN_VALUE = `(Get-ItemProperty -Path '${RUN_KEY}' -Name $env:AW_NAME -ErrorAction SilentlyContinue).$env:AW_NAME`;
const WRITE_RUN_VALUE = `Set-ItemProperty -Path '${RUN_KEY}' -Name $env:AW_NAME -Value $env:AW_VALUE -Type String`;
const DELETE_RUN_VALUE = `Remove-ItemProperty -Path '${RUN_KEY}' -Name $env:AW_NAME -ErrorAction SilentlyContinue`;

export function windowsAutostart(target: AutostartTarget, valueName: string = APP_NAME): Autostart {
  const command = windowsRunCommand(target, process.env.SystemRoot ?? "C:\\Windows");
  const location = `${RUN_KEY}\\${valueName}`;
  const read = () => powershell(READ_RUN_VALUE, { AW_NAME: valueName });
  return {
    location,
    command,
    isInstalled: async () => (await read()) !== "",
    async install(dryRun) {
      if ((await read()) === command) return { location, changed: false };
      if (!dryRun) await powershell(WRITE_RUN_VALUE, { AW_NAME: valueName, AW_VALUE: command });
      return { location, changed: true };
    },
    async uninstall(dryRun) {
      if ((await read()) === "") return { location, changed: false };
      if (!dryRun) await powershell(DELETE_RUN_VALUE, { AW_NAME: valueName });
      return { location, changed: true };
    },
  };
}

// ---------- files (macOS, Linux) ----------

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(target: AutostartTarget): string {
  const args = [target.nodePath, target.cliPath, ...START_ARGS]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/** Desktop Entry Exec quoting: wrap in double quotes, escape `"`, `` ` ``, `$` and `\`. */
function desktopQuote(arg: string): string {
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

export function xdgDesktopEntry(target: AutostartTarget): string {
  const exec = [target.nodePath, target.cliPath].map(desktopQuote).concat(START_ARGS).join(" ");
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Dashboard and notifications for AI coding agents
Exec=${exec}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

function fileAutostart(location: string, content: string): Autostart {
  return {
    location,
    command: content,
    isInstalled: async () => (await readTextIfExists(location)) !== null,
    async install(dryRun) {
      if ((await readTextIfExists(location)) === content) return { location, changed: false };
      if (!dryRun) {
        await mkdir(dirname(location), { recursive: true });
        await writeFile(location, content, "utf8");
      }
      return { location, changed: true };
    },
    async uninstall(dryRun) {
      if ((await readTextIfExists(location)) === null) return { location, changed: false };
      if (!dryRun) await rm(location, { force: true });
      return { location, changed: true };
    },
  };
}

export function autostartFor(platform: NodeJS.Platform, target: AutostartTarget): Autostart {
  switch (platform) {
    case "win32":
      return windowsAutostart(target);
    case "darwin":
      return fileAutostart(
        join(target.homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        launchdPlist(target),
      );
    default:
      return fileAutostart(
        join(target.homeDir, ".config", "autostart", `${APP_NAME}.desktop`),
        xdgDesktopEntry(target),
      );
  }
}
