import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, HOME_ENV_VAR, LEGACY_APP_NAMES } from "./constants.js";

function defaultHome(home: string): string {
  return join(home, `.${APP_NAME}`);
}

function legacyHomes(home: string): string[] {
  return LEGACY_APP_NAMES.map((name) => join(home, `.${name}`));
}

/**
 * ~/.agentwatch, or $AGENTWATCH_HOME. Until migrateLegacyHome has run, an existing folder from an
 * earlier project name is used instead, so hooks installed back then keep finding their token.
 */
export function appHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env[HOME_ENV_VAR];
  if (override && override.length > 0) return override;
  const current = defaultHome(home);
  if (existsSync(current)) return current;
  return legacyHomes(home).find((dir) => existsSync(dir)) ?? current;
}

/** Moves a legacy state folder to the current name. Returns the folder it moved, if any. */
export function migrateLegacyHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  if (env[HOME_ENV_VAR]) return null;
  const current = defaultHome(home);
  if (existsSync(current)) return null;
  const legacy = legacyHomes(home).find((dir) => existsSync(dir));
  if (!legacy) return null;
  try {
    renameSync(legacy, current);
    return legacy;
  } catch {
    return null; // e.g. a file is open on Windows; appHome keeps using the legacy folder until next time.
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
