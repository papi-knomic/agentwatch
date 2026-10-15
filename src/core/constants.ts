// The project name is a placeholder. Rename here (and in package.json) before the first release.
export const APP_NAME = "orchestrator";
export const APP_DISPLAY_NAME = "Orchestrator";

/** Overrides where the app keeps its config and state (default: ~/.<APP_NAME>). */
export const HOME_ENV_VAR = `${APP_NAME.toUpperCase()}_HOME`;

export const DEFAULT_PORT = 7878;

/** The hook must never hold up the agent, so the request to the server gives up quickly. */
export const HOOK_REQUEST_TIMEOUT_MS = 800;
export const HOOK_STDIN_TIMEOUT_MS = 500;
export const HOOK_STDIN_MAX_BYTES = 1024 * 1024;

export const MAX_MESSAGE_LENGTH = 200;
export const MAX_EVENT_BODY_BYTES = 64 * 1024;

/** Sessions with no events for this long are dropped (e.g. the agent was killed without a SessionEnd). */
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;
