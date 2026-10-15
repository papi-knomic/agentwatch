import { defaultToolSettings, type ToolSettings } from "../core/config.js";
import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex/index.js";
import { grokAdapter } from "./grok/index.js";
import type { Adapter } from "./types.js";

/** Register new tools here. Nothing outside src/adapters/ should import a specific adapter. */
export const adapters: readonly Adapter[] = [claudeCodeAdapter, codexAdapter, grokAdapter];

export function getAdapter(id: string): Adapter | undefined {
  return adapters.find((adapter) => adapter.meta.id === id);
}

export function toolDefaults(): Record<string, ToolSettings> {
  return Object.fromEntries(
    adapters.map(({ meta }) => [meta.id, defaultToolSettings(meta.displayName, meta.color, meta.sound)]),
  );
}
