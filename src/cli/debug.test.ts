import { describe, expect, it } from "vitest";
import { formatDecisionLog } from "./debug.js";

describe("formatDecisionLog", () => {
  it("renders a compact table and says so when empty", () => {
    expect(formatDecisionLog([])).toMatch(/No prompt decisions/);
    const text = formatDecisionLog([
      {
        at: "2026-11-16T10:11:12.000Z",
        tool: "claude-code",
        session: "abcd1234",
        kind: "permission",
        toolName: "Bash",
        agentId: false,
        hostClass: "concurrent",
        outcome: "registered",
        end: "orphan",
      },
    ]);
    const [head, row] = text.split("\n");
    expect(head).toMatch(/^time\s+tool\s+session/);
    expect(row).toMatch(
      /10:11:12\s+claude-code\s+abcd1234\s+permission\s+Bash\s+main\s+concurrent\s+registered\s+orphan$/,
    );
  });
});
