import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { adapters, toolDefaults } from "../adapters/index.js";
import { type Config, ensureConfig, readConfig } from "../core/config.js";
import { APP_DISPLAY_NAME, APP_NAME } from "../core/constants.js";
import { configPath, serverLogPath } from "../core/paths.js";
import { registerWindowsAppId } from "../notify/windows-identity.js";
import { createSetupService, type SetupState } from "../server/setup.js";
import { autostartFor } from "./autostart.js";
import { buildHookCommand } from "./hook-command.js";

export const serverUrl = (config: Pick<Config, "port">) => `http://127.0.0.1:${config.port}`;

export async function isRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
    const body = (await res.json()) as { app?: unknown };
    return body.app === APP_NAME;
  } catch {
    return false;
  }
}

/**
 * npx runs packages from a cache that npm may clear at any time. Hooks and login start-up store this
 * file's path, so installing from there would silently break later.
 */
export function assertStableInstall(cliPath: string): void {
  if (cliPath.includes(`${sep}_npx${sep}`)) {
    throw new Error(
      `${APP_NAME} is running from npx's temporary cache, so the hooks it installs would break when the cache is cleared.\n` +
        `Install it globally first:  npm install -g ${APP_NAME}  then run:  ${APP_NAME} setup`,
    );
  }
}

export function autostart(cliPath: string) {
  return autostartFor(process.platform, { nodePath: process.execPath, cliPath, homeDir: homedir() });
}

export function setupService(config: Config, cliPath: string) {
  return createSetupService({
    adapters,
    config,
    homeDir: homedir(),
    env: process.env,
    hookCommandFor: (toolId) => buildHookCommand(cliPath, toolId),
    autostartInstalled: () => autostart(cliPath).isInstalled(),
    afterConnect: async (dryRun) => {
      if (process.platform === "win32") await registerWindowsAppId({ dryRun });
    },
  });
}

async function waitUntilRunning(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Starts the server as a detached process with no window, logging to <appHome>/server.log. */
export async function startInBackground(cliPath: string): Promise<{ url: string; alreadyRunning: boolean }> {
  const config = await ensureConfig(toolDefaults());
  const url = serverUrl(config);
  if (await isRunning(url)) return { url, alreadyRunning: true };

  const logPath = serverLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [cliPath, "start"], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  if (!(await waitUntilRunning(url, 10_000))) {
    throw new Error(`The server didn't start. See ${logPath}`);
  }
  return { url, alreadyRunning: false };
}

export async function stopServer(): Promise<boolean> {
  const config = await readConfig(toolDefaults());
  if (!config) return false;
  const url = serverUrl(config);
  if (!(await isRunning(url))) return false;
  await fetch(`${url}/api/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(3000),
  });
  return true;
}

export function printSetup(setup: SetupState, url: string, running: boolean): void {
  console.log(`${APP_DISPLAY_NAME}`);
  console.log(
    `  Dashboard:  ${running ? url : "not running"}  (${APP_NAME} ${running ? "stop" : "start --background"})`,
  );
  console.log(`  Start at login: ${setup.autostart.installed ? "yes" : "no"}`);
  console.log(`  Config:     ${configPath()}`);
  console.log("");
  for (const tool of setup.tools) {
    const state = tool.error
      ? `error: ${tool.error}`
      : tool.connected
        ? "connected"
        : `not connected (${tool.command})`;
    console.log(`  ${tool.label.padEnd(12)} ${state}`);
    if (tool.connected)
      for (const step of tool.afterInstall) console.log(`  ${"".padEnd(12)} Reminder: ${step}`);
  }
}

export async function statusCommand(cliPath: string): Promise<void> {
  const config = await ensureConfig(toolDefaults());
  const url = serverUrl(config);
  printSetup(await setupService(config, cliPath).status(), url, await isRunning(url));
}
