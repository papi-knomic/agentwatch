// The command name (package.json "bin") and the name of the state folder, Grok hook file, etc.
export const APP_NAME = "agentwatch";
export const APP_DISPLAY_NAME = "AgentWatch";
/** The npm package (package.json "name"). npm rejected unscoped "agentwatch" as too close to "agent-watch". */
export const PACKAGE_NAME = "@kn0mic/agentwatch";

/**
 * Names this project shipped under before. Anything we created under them (state folder, Grok hook file,
 * Windows app id) is still found and cleaned up.
 */
export const LEGACY_APP_NAMES = ["orchestrator"] as const;

/** Windows app id that notifications are shown under once `install` has registered it. */
export const WINDOWS_APP_ID = `${APP_NAME}.notifications`;

/** Overrides where the app keeps its config and state (default: ~/.<APP_NAME>). */
export const HOME_ENV_VAR = `${APP_NAME.toUpperCase()}_HOME`;

export const DEFAULT_PORT = 7878;

/** The hook must never hold up the agent, so the request to the server gives up quickly. */
export const HOOK_REQUEST_TIMEOUT_MS = 800;
export const HOOK_STDIN_TIMEOUT_MS = 500;
export const HOOK_STDIN_MAX_BYTES = 1024 * 1024;

export const MAX_MESSAGE_LENGTH = 200;
export const MAX_TITLE_LENGTH = 80;
export const MAX_EVENT_BODY_BYTES = 64 * 1024;

/** Sessions with no events for this long are dropped (e.g. the agent was killed without a SessionEnd). */
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;
