import { APP_DISPLAY_NAME } from "../../src/core/constants.js";
import type { PendingDecision } from "./useAgentStream";

/**
 * Pure helpers for telling the user that a prompt is waiting for them while the dashboard is in the background
 * (tab title, favicon, browser notification). Nothing here reads a command or plan: only counts and names.
 */

/** The tab title: waiting prompts first (they hold an agent up), else the number of sessions that need you. */
export function alertTitle(waiting: number, attention: number): string {
  if (waiting > 0) return `(${waiting}) Waiting for you · ${APP_DISPLAY_NAME}`;
  return attention > 0 ? `(${attention}) ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;
}

const FAVICON_BASE =
  "<g fill='#18181b'><rect x='1' y='1' width='8' height='8' rx='2.5'/><rect x='11' y='1' width='8' height='8' rx='2.5'/>" +
  "<rect x='1' y='11' width='8' height='8' rx='2.5'/></g><rect x='11' y='11' width='8' height='8' rx='4' fill='#d4560b'/>";

/** The favicon as a data: URL, with a red count badge when something is waiting. */
export function faviconHref(waiting: number): string {
  const badge =
    waiting > 0
      ? `<circle cx='14' cy='6' r='6' fill='#dc2626'/><text x='14' y='9' font-size='9' font-family='sans-serif' font-weight='700' fill='#fff' text-anchor='middle'>${waiting > 9 ? "9+" : waiting}</text>`
      : "";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'>${FAVICON_BASE}${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Generic on purpose: which agent and project, never what it wants to run. */
export function notificationBody(toolLabel: string, project: string | undefined): string {
  return project
    ? `${toolLabel} in ${project} is waiting for your answer`
    : `${toolLabel} is waiting for your answer`;
}

/** Who asked, when it was a subagent. The main agent is the default and needs no caption. */
export function agentCaption(decision: Pick<PendingDecision, "agentId" | "agentType">): string | undefined {
  if (!decision.agentId) return undefined;
  return decision.agentType ? `subagent: ${decision.agentType}` : "subagent";
}
