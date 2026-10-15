import { isJsonObject, type JsonObject } from "./json-config.js";

/**
 * Edits the `hooks` section used by Claude Code's settings.json (also read by other tools, e.g. Grok):
 *   { "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 */

export type IsOurs = (command: unknown) => boolean;

function hooksSection(settings: JsonObject, path: string): JsonObject {
  const hooks = settings.hooks ?? {};
  if (!isJsonObject(hooks)) throw new Error(`"hooks" in ${path} is not an object; refusing to edit it.`);
  return hooks;
}

function matcherGroups(hooks: JsonObject, event: string, path: string): unknown[] {
  const groups = hooks[event] ?? [];
  if (!Array.isArray(groups))
    throw new Error(`"hooks.${event}" in ${path} is not an array; refusing to edit it.`);
  return groups;
}

function handlersOf(group: unknown): unknown[] {
  return isJsonObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
}

export function addClaudeStyleHooks(
  settings: JsonObject,
  events: readonly string[],
  handler: JsonObject & { command: string },
  isOurs: IsOurs,
  path: string,
  summary: string[],
): JsonObject {
  const hooks = hooksSection(settings, path);
  for (const event of events) {
    const groups = matcherGroups(hooks, event, path);
    const ours = groups.flatMap(handlersOf).find((h) => isJsonObject(h) && isOurs(h.command));
    if (isJsonObject(ours)) {
      // Already installed; refresh it in place if the CLI moved or the handler options changed.
      if (JSON.stringify(ours) !== JSON.stringify({ ...ours, ...handler })) {
        Object.assign(ours, handler);
        summary.push(`update ${event} hook`);
      }
      continue;
    }
    groups.push({ hooks: [{ ...handler }] });
    hooks[event] = groups;
    summary.push(`add ${event} hook`);
  }
  settings.hooks = hooks;
  return settings;
}

export function removeClaudeStyleHooks(
  settings: JsonObject,
  isOurs: IsOurs,
  path: string,
  summary: string[],
): JsonObject {
  if (settings.hooks === undefined) return settings;
  const hooks = hooksSection(settings, path);
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const kept = groups.flatMap((group) => {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((h) => !(isJsonObject(h) && isOurs(h.command)));
      if (remaining.length === group.hooks.length) return [group];
      removed = true;
      return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
    });
    if (!removed) continue;
    summary.push(`remove ${event} hook`);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  return settings;
}
