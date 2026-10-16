import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, HOME_ENV_VAR } from "./constants.js";

/** ~/.agentwatch, or $AGENTWATCH_HOME. */
export function appHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[HOME_ENV_VAR];
  return override && override.length > 0 ? override : join(home, `.${APP_NAME}`);
}

/**
 * The folder's real on-disk spelling. Tools report the same folder as "c:\\research\\x" and
 * "C:\\research\\x" (Windows paths are case-insensitive), which would otherwise show as two projects.
 * Falls back to the input when the path doesn't exist here.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appHome(env), "config.json");
}

export function sessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appHome(env), "sessions.json");
}

export function serverLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appHome(env), "server.log");
}
