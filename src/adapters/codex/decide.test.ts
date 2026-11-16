import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolDefaults } from "../../adapters/index.js";
import { type DecideDeps, runDecide } from "../../cli/decide.js";
import type { Config } from "../../core/config.js";
import { buildCodexDecideOutput, codexDecide } from "./decide.js";

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fixture = (name: string): unknown => JSON.parse(fixtureText(name));

const config: Config = {
  port: 1,
  token: "t".repeat(24),
  notifications: false,
  remoteActions: true,
  tools: toolDefaults(),
};

describe("codex decide.parse", () => {
  it("reads a PermissionRequest: preview from the command, blocking class", () => {
    const request = codexDecide.parse(fixture("permission-request.json"), {});
    expect(request).toMatchObject({
      kind: "permission",
      sessionId: "codex-sess-1",
      toolName: "shell",
      preview: "rm -rf build",
    });
    expect(request?.concurrent).toBeUndefined();
    expect(request?.agentId).toBeUndefined();
  });

  it("carries the subagent that is asking", () => {
    expect(codexDecide.parse(fixture("permission-request-subagent.json"), {})).toMatchObject({
      agentId: "agent-7f3a",
      agentType: "worker",
      preview: "npm publish",
    });
  });

  it("joins an argv command and drops an invalid agent id", () => {
    const base = fixture("permission-request.json") as Record<string, unknown>;
    const request = codexDecide.parse(
      { ...base, tool_input: { command: ["git", "push"] }, agent_id: "bad id!" },
      {},
    );
    expect(request?.preview).toBe("git push");
    expect(request?.agentId).toBeUndefined();
  });

  it.each(["post-tool-use.json", "stop.json", "subagent-start.json", "question-async.json"])(
    "ignores %s",
    (file) => {
      expect(codexDecide.parse(fixture(file), {})).toBeNull();
    },
  );

  it("ignores payloads without a session or tool", () => {
    const base = fixture("permission-request.json") as Record<string, unknown>;
    expect(codexDecide.parse({ ...base, session_id: "" }, {})).toBeNull();
    expect(codexDecide.parse({ ...base, tool_name: 3 }, {})).toBeNull();
    expect(codexDecide.parse("x", {})).toBeNull();
  });
});

describe("codex decide.buildOutput", () => {
  const request = codexDecide.parse(fixture("permission-request.json"), {});
  if (!request) throw new Error("fixture must parse");

  it("allows with the bare documented shape, never updatedInput / updatedPermissions / interrupt", () => {
    const output = buildCodexDecideOutput(request, { behavior: "allow" }) ?? "";
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(output).not.toMatch(/updatedInput|updatedPermissions|interrupt/);
  });

  it("denies with a message, even when the dashboard sent feedback", () => {
    const output = buildCodexDecideOutput(request, { behavior: "deny", message: "no" }) ?? "";
    expect(JSON.parse(output).hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: "Denied from the AgentWatch dashboard.",
    });
    expect(output).not.toMatch(/updatedInput|updatedPermissions|interrupt/);
  });

  it("stays silent for answers (questions are not supported)", () => {
    expect(buildCodexDecideOutput(request, { answers: { q: "a" } })).toBeNull();
  });
});

describe("runDecide --tool codex", () => {
  function run(stdin: string, fetchImpl: typeof fetch) {
    const printed: string[] = [];
    const urls: string[] = [];
    const deps: DecideDeps = {
      readStdin: async () => stdin,
      env: {},
      readConfig: async () => config,
      fetch: async (input, init) => {
        urls.push(String(input));
        return fetchImpl(input, init);
      },
      print: async (line) => {
        printed.push(line);
      },
      now: Date.now,
      sleep: async () => {},
      deadlineMs: 300,
    };
    return runDecide("codex", deps).then(() => ({ printed, urls }));
  }

  it("registers a blocking permission decision and prints the answer", async () => {
    let body: Record<string, unknown> = {};
    const { printed } = await run(fixtureText("permission-request-subagent.json"), async (input, init) => {
      if (String(input).endsWith("/api/decisions")) {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "d1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ behavior: "allow" }), { status: 200 });
    });
    expect(body).toMatchObject({
      tool: "codex",
      sessionId: "codex-sess-1",
      kind: "permission",
      toolName: "shell",
      agentId: "agent-7f3a",
      agentType: "worker",
      preview: "npm publish",
    });
    expect(body.concurrent).toBeUndefined();
    expect(printed).toHaveLength(1);
    expect(printed[0]).not.toMatch(/updatedInput/);
  });

  it("stays silent when no dashboard is open", async () => {
    const { printed, urls } = await run(
      fixtureText("permission-request.json"),
      async () => new Response(JSON.stringify({ id: null, reason: "no_viewer" }), { status: 200 }),
    );
    expect(printed).toEqual([]);
    expect(urls).toHaveLength(1);
  });
});
