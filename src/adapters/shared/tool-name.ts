/** "Bash" stays "Bash"; "mcp__github__create_issue" becomes "github · create_issue". */
export function formatToolName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** The working-row activity line after a tool call: the tool's name, marked if it failed. */
export function toolActivity(name: string | undefined, failed = false): string | undefined {
  const tool = formatToolName(name);
  if (!tool) return undefined;
  return failed ? `${tool} failed` : tool;
}
