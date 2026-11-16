import { toolDefaults } from "../adapters/index.js";
import { readConfig } from "../core/config.js";
import { APP_NAME } from "../core/constants.js";
import type { DebugRecord } from "../server/decisions.js";
import { serverUrl } from "./service.js";

/** Renders the ring buffer as a compact table. Pure, so it can be tested without a server. */
export function formatDecisionLog(records: readonly DebugRecord[]): string {
  if (records.length === 0) return "No prompt decisions have been attempted since the server started.";
  const rows = records.map((r) => [
    r.at.slice(11, 19),
    r.tool,
    r.session,
    r.kind,
    r.toolName,
    r.agentId ? "sub" : "main",
    r.hostClass,
    r.reason ? `${r.outcome}: ${r.reason}` : r.outcome,
    r.end ?? (r.outcome === "registered" ? "pending" : "-"),
  ]);
  const head = ["time", "tool", "session", "kind", "toolName", "agent", "host", "outcome", "end"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

function isRecordList(value: unknown): value is DebugRecord[] {
  return Array.isArray(value) && value.every((r) => typeof r === "object" && r !== null);
}

/** `agentwatch debug decisions`: the last prompt-card attempts, from the running server (this computer only). */
export async function debugDecisionsCommand(): Promise<void> {
  const config = await readConfig(toolDefaults());
  if (!config) throw new Error(`No config yet. Run: ${APP_NAME} setup`);
  let res: Response;
  try {
    res = await fetch(`${serverUrl(config)}/api/debug/decisions`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error(`The server isn't running. Start it with: ${APP_NAME} start --background`);
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}. Is it an older version? Restart it.`);
  const body = (await res.json()) as { decisions?: unknown };
  console.log(formatDecisionLog(isRecordList(body.decisions) ? body.decisions : []));
}
