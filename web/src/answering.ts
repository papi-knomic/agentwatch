import type { Setup } from "./setup";

/**
 * Whether answering from the dashboard is in an inconsistent state. A tool deliberately left off is normal; what is
 * not: the master switch on with no tool answering, a tool answering while the master switch is off, or a config
 * that can't be read.
 */
export function answeringNeedsAttention(setup: Setup | null): boolean {
  if (!setup) return false;
  const remote = setup.remoteActions;
  if (!remote.supported) return false;
  const anyOn = remote.perTool.some((tool) => tool.answering === "on");
  return remote.enabled !== anyOn;
}
