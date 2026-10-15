import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME, HOME_ENV_VAR } from "./constants.js";

export function appHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HOME_ENV_VAR];
  return override && override.length > 0 ? override : join(homedir(), `.${APP_NAME}`);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appHome(env), "config.json");
}

export function sessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appHome(env), "sessions.json");
}
