import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolDefaults } from "../adapters/index.js";
import { type Config, defaultToolSettings } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import { DecisionStore } from "../server/decisions.js";
import { createAppServer } from "../server/server.js";
import { type DecideDeps, runDecide } from "./decide.js";

const TOKEN = "decide-test-token-0123456789";
const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../adapters/claude-code/fixtures/${name}`, import.meta.url)), "utf8");

function baseConfig(port: number, remoteActions = true): Config {
  return { port, token: TOKEN, notifications: false, remoteActions, tools: toolDefaults() };
}

interface Harness {
  deps: DecideDeps;
  printed: string[];
  fetches: string[];
}

function harness(stdin: string, config: Config | null, overrides: Partial<DecideDeps> = {}): Harness {
  const printed: string[] = [];
  const fetches: string[] = [];
  const deps: DecideDeps = {
    readStdin: async () => stdin,
    env: {},
    readConfig: async () => config,
    fetch: async (input) => {
      fetches.push(String(input));
      throw new Error("no network in this test");
    },
    print: async (line) => {
      printed.push(line);
    },
    now: Date.now,
    sleep: async () => {},
    deadlineMs: 300,
    ...overrides,
  };
  return { deps, printed, fetches };
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("runDecide falls through silently", () => {
  let permission: string;
  let question: string;
  beforeEach(async () => {
    permission = await fixture("permission-request.json");
    question = await fixture("pre-tool-use-ask-user-question.json");
  });

  it("when remote actions are off, the tool is disabled, or there is no config", async () => {
    for (const config of [
      baseConfig(1, false),
      null,
      {
        ...baseConfig(1),
        tools: {
          ...toolDefaults(),
          "claude-code": { ...defaultToolSettings("Claude Code", "#d97757", "default"), enabled: false },
        },
      },
    ]) {
      const h = harness(permission, config);
      await expect(runDecide("claude-code", h.deps)).resolves.toBeUndefined();
      expect(h.printed).toEqual([]);
      expect(h.fetches).toEqual([]);
    }
  });

  it("for other tools, Grok's calls, and payloads it does not handle", async () => {
    const cases: [string | undefined, string, NodeJS.ProcessEnv][] = [
      ["codex", permission, {}],
      [undefined, permission, {}],
      ["claude-code", permission, { GROK_SESSION_ID: "g1" }],
      ["claude-code", permission, { GROK_HOOK_EVENT: "x" }],
      ["claude-code", "{ not json", {}],
      ["claude-code", "", {}],
      ["claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), {}],
      // Questions are answered from PreToolUse only.
      ["claude-code", JSON.stringify({ ...JSON.parse(permission), tool_name: "AskUserQuestion" }), {}],
      // A PreToolUse for any other tool is none of our business.
      ["claude-code", JSON.stringify({ ...JSON.parse(question), tool_name: "Bash" }), {}],
      ["claude-code", JSON.stringify({ ...JSON.parse(question), tool_input: { questions: [] } }), {}],
      ["claude-code", JSON.stringify({ ...JSON.parse(permission), tool_input: "x" }), {}],
    ];
    for (const [tool, stdin, env] of cases) {
      const h = harness(stdin, baseConfig(1), { env });
      await expect(runDecide(tool, h.deps)).resolves.toBeUndefined();
      expect(h.printed).toEqual([]);
      expect(h.fetches).toEqual([]);
    }
  });

  it("for a multi-select question whose labels contain a comma (the answer string would be ambiguous)", async () => {
    const payload = JSON.parse(question) as { tool_input: { questions: unknown } };
    payload.tool_input.questions = [
      { question: "Colours?", multiSelect: true, options: [{ label: "Red, green" }, { label: "Blue" }] },
    ];
    const h = harness(JSON.stringify(payload), baseConfig(1));
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
    expect(h.fetches).toEqual([]);
    // A single-select question may contain commas: only one label is ever returned.
    payload.tool_input.questions = [
      { question: "Colour?", multiSelect: false, options: [{ label: "Red, green" }, { label: "Blue" }] },
    ];
    const single = harness(JSON.stringify(payload), baseConfig(1));
    await runDecide("claude-code", single.deps);
    expect(single.fetches).toEqual(["http://127.0.0.1:1/api/decisions"]);
  });

  it("when the server is down", async () => {
    const h = harness(permission, baseConfig(1));
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
    expect(h.fetches).toEqual(["http://127.0.0.1:1/api/decisions"]);
  });

  it("when no dashboard is open (id: null) without polling", async () => {
    const calls: string[] = [];
    const h = harness(permission, baseConfig(1), {
      fetch: async (input) => {
        calls.push(String(input));
        return json(200, { id: null, reason: "no_viewer" });
      },
    });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("when the server refuses the registration", async () => {
    const h = harness(permission, baseConfig(1), { fetch: async () => json(401, { error: "no" }) });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
  });

  it("when the request is over (410), such as answered in the terminal", async () => {
    let n = 0;
    const h = harness(permission, baseConfig(1), {
      fetch: async () => (n++ === 0 ? json(200, { id: "abc" }) : json(410, { error: "over" })),
    });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
    expect(n).toBe(2);
  });

  it("at the deadline, after polling in chunks", async () => {
    let now = 0;
    let polls = 0;
    const h = harness(permission, baseConfig(1), {
      now: () => now,
      deadlineMs: 60_000,
      fetch: async (input) => {
        if (String(input).endsWith("/api/decisions")) return json(200, { id: "abc" });
        polls += 1;
        const ms = Number(new URL(String(input)).searchParams.get("ms"));
        expect(ms).toBeLessThanOrEqual(25_000);
        now += ms;
        return json(204);
      },
    });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
    expect(polls).toBe(3); // 25 s + 25 s + 10 s
  });

  it("gives up after repeated poll failures, but survives one dropped connection", async () => {
    let polls = 0;
    const flaky = harness(permission, baseConfig(1), {
      fetch: async (input) => {
        if (String(input).endsWith("/api/decisions")) return json(200, { id: "abc" });
        polls += 1;
        if (polls === 1) throw new Error("dropped");
        return json(200, { behavior: "deny" });
      },
    });
    await runDecide("claude-code", flaky.deps);
    expect(flaky.printed).toHaveLength(1);

    polls = 0;
    const dead = harness(permission, baseConfig(1), {
      fetch: async (input) => {
        if (String(input).endsWith("/api/decisions")) return json(200, { id: "abc" });
        polls += 1;
        throw new Error("down");
      },
    });
    await runDecide("claude-code", dead.deps);
    expect(dead.printed).toEqual([]);
    expect(polls).toBe(2);
  });

  it("when the answer does not fit the question", async () => {
    const h = harness(permission, baseConfig(1), {
      fetch: async (input) =>
        String(input).endsWith("/api/decisions")
          ? json(200, { id: "abc" })
          : json(200, { answers: { q: "a" } }),
    });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
  });
});

describe("runDecide output", () => {
  const answerWith = (resolution: unknown, seen: { body?: unknown } = {}) =>
    (async (input, init) => {
      if (String(input).endsWith("/api/decisions")) {
        seen.body = JSON.parse(String(init?.body));
        return json(200, { id: "abc" });
      }
      return json(200, resolution);
    }) as typeof fetch;

  it("prints allow with the original input echoed as updatedInput", async () => {
    const seen: { body?: unknown } = {};
    const stdin = await fixture("permission-request.json");
    const h = harness(stdin, baseConfig(1), { fetch: answerWith({ behavior: "allow" }, seen) });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toHaveLength(1);
    expect(JSON.parse(h.printed[0] as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { command: "npm test", description: "Run the test suite" },
        },
      },
    });
    expect(h.printed[0]).not.toContain("\n");
    expect(seen.body).toEqual({
      tool: "claude-code",
      sessionId: "sess-demo-1",
      kind: "permission",
      toolName: "Bash",
      preview: "npm test",
    });
  });

  it("prints deny with a message", async () => {
    const stdin = await fixture("permission-request.json");
    const h = harness(stdin, baseConfig(1), { fetch: answerWith({ behavior: "deny" }) });
    await runDecide("claude-code", h.deps);
    expect(JSON.parse(h.printed[0] as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied from the AgentWatch dashboard." },
      },
    });
  });

  it("echoes the plan input for ExitPlanMode and sends the plan as the preview", async () => {
    const seen: { body?: unknown } = {};
    const input = { plan: "1. Do it" };
    const stdin = JSON.stringify({
      ...JSON.parse(await fixture("permission-request.json")),
      tool_name: "ExitPlanMode",
      tool_input: input,
    });
    const h = harness(stdin, baseConfig(1), { fetch: answerWith({ behavior: "allow" }, seen) });
    await runDecide("claude-code", h.deps);
    expect(JSON.parse(h.printed[0] as string).hookSpecificOutput.decision.updatedInput).toEqual(input);
    expect(seen.body).toMatchObject({ kind: "plan", preview: "1. Do it" });
  });

  it("denies a plan with the user's feedback, or a default when there is none", async () => {
    const stdin = JSON.stringify({
      ...JSON.parse(await fixture("permission-request.json")),
      tool_name: "ExitPlanMode",
      tool_input: { plan: "1. Do it" },
    });
    const decisionFor = async (resolution: unknown) => {
      const h = harness(stdin, baseConfig(1), { fetch: answerWith(resolution) });
      await runDecide("claude-code", h.deps);
      return JSON.parse(h.printed[0] as string).hookSpecificOutput;
    };
    expect(await decisionFor({ behavior: "deny", message: "  Also add tests  " })).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Also add tests" },
    });
    expect((await decisionFor({ behavior: "deny" })).decision.message).toBe(
      "The user wants to keep planning.",
    );
  });

  it("does not use plan feedback for ordinary permission denials", async () => {
    const stdin = await fixture("permission-request.json");
    const h = harness(stdin, baseConfig(1), { fetch: answerWith({ behavior: "deny", message: "x" }) });
    await runDecide("claude-code", h.deps);
    expect(JSON.parse(h.printed[0] as string).hookSpecificOutput.decision.message).toBe(
      "Denied from the AgentWatch dashboard.",
    );
  });

  it("prints the PreToolUse answer for AskUserQuestion with the questions echoed", async () => {
    const stdin = await fixture("pre-tool-use-ask-user-question.json");
    const original = JSON.parse(stdin).tool_input.questions;
    const answers = {
      "Which database should the app use?": "SQLite",
      "Which extras do you want?": "Linting, CI",
    };
    const seen: { body?: unknown } = {};
    const h = harness(stdin, baseConfig(1), { fetch: answerWith({ answers }, seen) });
    await runDecide("claude-code", h.deps);
    expect(JSON.parse(h.printed[0] as string)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { questions: original, answers },
      },
    });
    expect(seen.body).toMatchObject({ kind: "question", toolName: "AskUserQuestion" });
  });

  it("never prints a permission answer for a question or the reverse", async () => {
    const h = harness(await fixture("pre-tool-use-ask-user-question.json"), baseConfig(1), {
      fetch: answerWith({ behavior: "allow" }),
    });
    await runDecide("claude-code", h.deps);
    expect(h.printed).toEqual([]);
  });
});

describe("runDecide against a real server", () => {
  let server: ReturnType<typeof createAppServer>;
  let store: SessionStore;
  let config: Config;
  let home: string;
  let port: number;
  let stream: { destroy: () => void } | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-decide-"));
    store = new SessionStore();
    config = baseConfig(0);
    server = createAppServer({
      config,
      store,
      decisions: new DecisionStore(),
      tools: [],
      staticDir: "does-not-exist",
      version: "0.0.0-test",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    config.port = port;
    store.apply({
      tool: "claude-code",
      sessionId: "sess-demo-1",
      cwd: "C:\\p",
      status: "working",
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    stream?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  /** Like the dashboard: a stream with a client id, then a "visible" report. */
  function openDashboard(): Promise<void> {
    return new Promise((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/api/stream?client=decide-test-client",
        headers: { host: `127.0.0.1:${port}` },
      });
      req.on("response", (res) => {
        res.resume();
        const presence = request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/presence",
            headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
          },
          (r) => {
            r.resume();
            resolve();
          },
        );
        presence.end(JSON.stringify({ clientId: "decide-test-client", visible: true }));
      });
      req.on("error", () => {});
      req.end();
      stream = req;
    });
  }

  function dashboardResolves(body: unknown): Promise<void> {
    return (async () => {
      for (let i = 0; i < 100; i++) {
        const [decision] = (
          (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as {
            decisions: { id: string }[];
          }
        ).decisions;
        if (decision) {
          const res = await new Promise<number>((resolve) => {
            const req = request(
              {
                host: "127.0.0.1",
                port,
                method: "POST",
                path: `/api/decisions/${decision.id}/resolve`,
                headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
              },
              (r) => {
                r.resume();
                resolve(r.statusCode ?? 0);
              },
            );
            req.end(JSON.stringify(body));
          });
          expect(res).toBe(200);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("no decision appeared");
    })();
  }

  it("does not wait at all while no dashboard is open", async () => {
    const h = harness(await fixture("permission-request.json"), config, { fetch, deadlineMs: 5_000 });
    const started = Date.now();
    await runDecide("claude-code", h.deps);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(h.printed).toEqual([]);
  });

  it("prints the dashboard's approval", async () => {
    await openDashboard();
    const h = harness(await fixture("permission-request.json"), config, { fetch, deadlineMs: 5_000 });
    const [,] = await Promise.all([
      runDecide("claude-code", h.deps),
      dashboardResolves({ behavior: "allow" }),
    ]);
    expect(JSON.parse(h.printed[0] as string).hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("prints the dashboard's answers to a question", async () => {
    await openDashboard();
    const answers = {
      "Which database should the app use?": "PostgreSQL",
      "Which extras do you want?": ["CI", "Linting"],
    };
    const h = harness(await fixture("pre-tool-use-ask-user-question.json"), config, {
      fetch,
      deadlineMs: 5_000,
    });
    await Promise.all([runDecide("claude-code", h.deps), dashboardResolves({ answers })]);
    expect(JSON.parse(h.printed[0] as string).hookSpecificOutput.updatedInput.answers).toEqual({
      "Which database should the app use?": "PostgreSQL",
      "Which extras do you want?": "Linting, CI",
    });
  });
});
