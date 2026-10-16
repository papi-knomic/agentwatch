import { spawn } from "node:child_process";
import { join } from "node:path";
import { APP_DISPLAY_NAME, WINDOWS_APP_ID } from "../core/constants.js";
import { appHome } from "../core/paths.js";
import { APP_ICON_FILE, ensureAppIcon } from "./icon.js";

/**
 * Registering an app id here gives toasts our own name and icon, with no Start Menu shortcut and no admin
 * rights. Not documented by Microsoft for this purpose; it is what the Windows-Toasts library's
 * register_hkey_aumid.py writes (DisplayName and IconUri, both REG_SZ), and was verified by hand on Windows 11.
 */
export const WINDOWS_APP_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_ID}`;

export interface RegResult {
  code: number;
  stdout: string;
}

export type RegRunner = (args: string[]) => Promise<RegResult>;

export const runReg: RegRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout }));
  });

/** Parses `reg query` output (`    Name    REG_SZ    Data`) into value name → data. */
export function parseRegQuery(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^ {4}(\S.*?) {4}REG_\w+ {4}(.*)$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? "";
  }
  return values;
}

export interface IdentityResult {
  changed: boolean;
  summary: string[];
}

interface IdentityOptions {
  dryRun: boolean;
  iconDir?: string;
  reg?: RegRunner;
}

export async function registerWindowsAppId(options: IdentityOptions): Promise<IdentityResult> {
  const reg = options.reg ?? runReg;
  const iconDir = options.iconDir ?? join(appHome(), "icons");
  const iconPath = options.dryRun ? join(iconDir, APP_ICON_FILE) : await ensureAppIcon(iconDir);

  const current = await reg(["query", WINDOWS_APP_KEY]);
  const values = current.code === 0 ? parseRegQuery(current.stdout) : {};
  const wanted: [string, string][] = [
    ["DisplayName", APP_DISPLAY_NAME],
    ["IconUri", iconPath],
  ];
  const changes = wanted.filter(([name, value]) => values[name] !== value);
  const summary = changes.map(([name, value]) => `set ${name} = ${value}`);
  if (!options.dryRun) {
    for (const [name, value] of changes) {
      const result = await reg(["add", WINDOWS_APP_KEY, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
      if (result.code !== 0) throw new Error(`Could not write ${name} under ${WINDOWS_APP_KEY}`);
    }
  }
  return { changed: summary.length > 0, summary };
}

/** Removes exactly the key that registerWindowsAppId creates. */
export async function unregisterWindowsAppId(options: IdentityOptions): Promise<IdentityResult> {
  const reg = options.reg ?? runReg;
  if ((await reg(["query", WINDOWS_APP_KEY])).code !== 0) return { changed: false, summary: [] };
  if (!options.dryRun && (await reg(["delete", WINDOWS_APP_KEY, "/f"])).code !== 0) {
    throw new Error(`Could not remove ${WINDOWS_APP_KEY}`);
  }
  return { changed: true, summary: [`remove ${WINDOWS_APP_KEY}`] };
}
