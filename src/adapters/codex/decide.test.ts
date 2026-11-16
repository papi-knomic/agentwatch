import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolDefaults } from "../../adapters/index.js";
import { type DecideDeps, runDecide } from "../../cli/decide.js";
import type { Config } from "../../core/config.js";
import { buildCodexDecideOutput, CODEX_MAX_HOLD_MS, codexDecide, readApprovalsReviewer } from "./decide.js";

// Never the real ~/.codex: an empty temp CODEX_HOME.
const emptyHome = mkdtempSync(join(tmpdir(), "aw-codex-decide-"));
const NL = "\n";
const ENV: NodeJS.ProcessEnv = { CODEX_HOME: emptyHome };
const envWith = (toml: string): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), "aw-codex-cfg-"));
  writeFileSync(join(dir, "config.toml"), toml);
  return { CODEX_HOME: dir };
};

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
    const request = codexDecide.parse(fixture("permission-request.json"), ENV);
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
    expect(codexDecide.parse(fixture("permission-request-subagent.json"), ENV)).toMatchObject({
      agentId: "agent-7f3a",
      agentType: "worker",
      preview: "npm publish",
    });
  });

  it("joins an argv command and drops an invalid agent id", () => {
    const base = fixture("permission-request.json") as Record<string, unknown>;
    const request = codexDecide.parse(
      { ...base, tool_input: { command: ["git", "push"] }, agent_id: "bad id!" },
      ENV,
    );
    expect(request?.preview).toBe("git push");
    expect(request?.agentId).toBeUndefined();
  });

  it.each(["post-tool-use.json", "stop.json", "subagent-start.json", "question-async.json"])(
    "ignores %s",
    (file) => {
      expect(codexDecide.parse(fixture(file), ENV)).toBeNull();
    },
  );

  it("ignores payloads without a session or tool", () => {
    const base = fixture("permission-request.json") as Record<string, unknown>;
    expect(codexDecide.parse({ ...base, session_id: "" }, ENV)).toBeNull();
    expect(codexDecide.parse({ ...base, tool_name: 3 }, ENV)).toBeNull();
    expect(codexDecide.parse("x", ENV)).toBeNull();
  });
});

describe("codex auto reviewer", () => {
  const payload = fixture("permission-request.json");
  const parsed = (toml: string) => codexDecide.parse(payload, envWith(toml));

  it("returns no decision when approvals_reviewer is auto_review or its alias", () => {
    expect(parsed(['model = "x"', 'approvals_reviewer = "auto_review"'].join(NL))).toBeNull();
    expect(parsed(["approvals_reviewer = 'guardian_subagent' # old name"].join(NL))).toBeNull();
  });

  it("reads the active profile, which overrides the top level", () => {
    const toml = [
      'profile = "fast"',
      'approvals_reviewer = "user"',
      "[profiles.fast]",
      'approvals_reviewer = "auto_review"',
      "[profiles.other]",
      'approvals_reviewer = "user"',
    ].join(NL);
    expect(parsed(toml)).toBeNull();
    expect(parsed(toml.replace('profile = "fast"', 'profile = "other"'))).not.toBeNull();
    const quoted = ['profile = "x"', '[profiles."x"]', 'approvals_reviewer = "auto_review"'].join(NL);
    expect(readApprovalsReviewer(quoted)).toBe("auto_review");
    // a key inside an unrelated table is not the top-level setting
    expect(parsed(["[mcp_servers.a]", 'approvals_reviewer = "auto_review"'].join(NL))).not.toBeNull();
  });

  it("still decides when the setting is absent, is user, or the file is missing, huge or unreadable", () => {
    expect(parsed('model = "x"')).not.toBeNull();
    expect(parsed('approvals_reviewer = "user"')).not.toBeNull();
    expect(codexDecide.parse(payload, { CODEX_HOME: join(emptyHome, "nope") })).not.toBeNull();
    expect(
      parsed([`# ${"x".repeat(300_000)}`, 'approvals_reviewer = "auto_review"'].join(NL)),
    ).not.toBeNull();
    // config.toml is a directory: unreadable
    const dir = mkdtempSync(join(tmpdir(), "aw-codex-dir-"));
    mkdirSync(join(dir, "config.toml"));
    expect(codexDecide.parse(payload, { CODEX_HOME: dir })).not.toBeNull();
  });

  it("asks for a visible tab and a 30 s cap", () => {
    expect(codexDecide.parse(payload, ENV)?.holdPolicy).toEqual({
      visibleOnly: true,
      maxHoldMs: CODEX_MAX_HOLD_MS,
    });
    expect(CODEX_MAX_HOLD_MS).toBe(30_000);
  });
});

describe("codex decide.buildOutput", () => {
  const request = codexDecide.parse(fixture("permission-request.json"), ENV);
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
      env: ENV,
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
    expect(body).toMatchObject({ visibleOnly: true, maxHoldMs: 30_000 });
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
