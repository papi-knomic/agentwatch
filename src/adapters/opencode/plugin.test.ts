import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeOpenCode } from "./normalize.js";
import { commandArgv, PLUGIN_MARKER, pluginSource } from "./plugin.js";

// Loads the generated plugin the way OpenCode would and checks what it actually sends to the hook command.

interface Hooks {
  event: (input: unknown) => Promise<void>;
}

interface SubscribeOptions {
  types?: string[];
  signal?: AbortSignal;
}

interface PluginModule {
  id: string;
  server: (input: unknown) => Promise<Hooks>;
  setup: (ctx: unknown) => unknown;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));

const fixtureV2 = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}`, import.meta.url), "utf8"));

const CWD = "C:\\Users\\dev\\projects\\web";
const SESSION_V2 = "ses_e40543cc2ffewW3gz0p0TD4jA8";
// Stands in for `agentwatch hook`: argv[2] is where to write, the last argument is the payload.
const SINK = `import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
writeFileSync(join(process.argv[2], randomUUID() + ".json"), process.argv[process.argv.length - 1]);
`;

let dir: string;
let outDir: string;

async function loadModule(command?: string): Promise<PluginModule> {
  const sink = join(dir, "sink.mjs").replace(/\\/g, "/");
  const out = outDir.replace(/\\/g, "/");
  const file = join(dir, `agentwatch-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, pluginSource(command ?? `node "${sink}" "${out}" hook --tool opencode`));
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  // 2.x requires a default definition; 1.x treats any other export as a plugin of its own.
  expect(Object.keys(mod)).toEqual(["default"]);
  return mod.default as PluginModule;
}

/** OpenCode 1.x: `default.server(input)` returns the hooks. */
async function loadV1(): Promise<Hooks> {
  return (await loadModule()).server({ directory: CWD });
}

/** OpenCode 2.x: `default.setup(ctx)`, with events streamed from `ctx.event.subscribe()`. */
function contextV2(events: unknown[]) {
  const subscribed: SubscribeOptions[] = [];
  const ctx = {
    location: { directory: CWD, project: { id: "global", directory: CWD, canonical: CWD } },
    event: {
      subscribe(options: SubscribeOptions) {
        subscribed.push(options);
        return (async function* () {
          for (const event of events) {
            if (options.signal?.aborted) return;
            yield event;
            // Distinct timestamps, so the order can be checked.
            await new Promise((resolve) => setTimeout(resolve, 3));
          }
        })();
      },
    },
  };
  return { ctx, subscribed };
}

async function sent(count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 25_000;
  let files: string[] = [];
  while (Date.now() < deadline) {
    files = await readdir(outDir);
    if (files.length >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Anything extra would show up shortly after the last expected one.
  await new Promise((resolve) => setTimeout(resolve, 500));
  files = await readdir(outDir);
  const payloads = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(outDir, f), "utf8"))),
  );
  return payloads.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const statusesOf = (payloads: Array<Record<string, unknown>>) =>
  payloads.map((p) => normalizeOpenCode(p, { env: {}, now: new Date() })?.status);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-opencode-plugin-"));
  outDir = join(dir, "out");
  await mkdir(outDir);
  await writeFile(join(dir, "sink.mjs"), SINK);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Each send starts a real Node process; on a busy Windows machine six of them can take ~10s.
describe("OpenCode plugin", { timeout: 30_000 }, () => {
  it("starts with the marker install and uninstall look for", () => {
    expect(pluginSource('node "/x/cli.js" hook --tool opencode').startsWith(PLUGIN_MARKER)).toBe(true);
  });

  it("runs the hook command without a shell, keeping quoted paths whole", () => {
    expect(commandArgv('node "C:/Program Files/agentwatch/cli.js" hook --tool opencode')).toEqual([
      "node",
      "C:/Program Files/agentwatch/cli.js",
      "hook",
      "--tool",
      "opencode",
    ]);
  });

  it("exports one definition both OpenCode majors accept", async () => {
    const plugin = await loadModule();
    expect(plugin.id).toBe("agentwatch");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });

  describe("OpenCode 1.x", () => {
    it("sends one cut-down event per change in the captured session", async () => {
      const hooks = await loadV1();
      // The order OpenCode 1.19.3 emitted them in, minus message/part/diff noise.
      for (const name of [
        "session-created.json",
        "session-status-busy.json",
        "session-status-busy.json",
        "session-updated-title.json",
        "session-status-busy.json",
        "permission-asked-edit.json",
        "permission-replied-once.json",
        "session-status-busy.json",
        "session-status-idle.json",
        "session-idle.json",
      ]) {
        await hooks.event({ event: fixture(name) });
        // Distinct timestamps, so the order can be checked below.
        await new Promise((resolve) => setTimeout(resolve, 3));
      }

      const payloads = await sent(6);
      expect(payloads.map((p) => (p.event as { type: string }).type)).toEqual([
        "session.status",
        "session.status",
        "permission.asked",
        "permission.replied",
        "session.status",
        "session.idle",
      ]);
      // The raw event carries the file's path and diff; only the permission's kind may leave OpenCode.
      expect(payloads[2]?.event).toEqual({
        type: "permission.asked",
        properties: { sessionID: "ses_ea930fb5affekKS0B120gDMDYx", permission: "edit" },
      });
      expect(payloads[0]).toMatchObject({
        v: 1,
        directory: CWD,
        pid: process.pid,
        title: expect.stringMatching(/^New session/),
      });
      expect(payloads[1]?.title).toBe('Adding "world" to hello.txt');
      expect(statusesOf(payloads)).toEqual([
        "working",
        "working",
        "needs_input",
        "working",
        "working",
        "done",
      ]);
    });

    it("marks a subagent's events with the session the user is looking at", async () => {
      const hooks = await loadV1();
      await hooks.event({ event: fixture("session-created.json") });
      await hooks.event({ event: fixture("session-created-child.json") });
      const ask = fixture("permission-asked-bash.json") as { properties: Record<string, unknown> };
      await hooks.event({
        event: { ...ask, properties: { ...ask.properties, sessionID: "ses_child00000000000000000001" } },
      });
      const [payload] = await sent(1);
      expect(payload).toMatchObject({ rootSessionID: "ses_ea930fb5affekKS0B120gDMDYx" });
      expect(normalizeOpenCode(payload, { env: {}, now: new Date() })).toMatchObject({
        sessionId: "ses_ea930fb5affekKS0B120gDMDYx",
        status: "needs_input",
      });
    });

    it("tells normalize which error ended the turn", async () => {
      const hooks = await loadV1();
      await hooks.event({ event: fixture("session-error.json") });
      await new Promise((resolve) => setTimeout(resolve, 3));
      await hooks.event({ event: fixture("session-idle.json") });
      const payloads = await sent(2);
      expect(payloads[1]).toMatchObject({ afterError: "APIError" });
      const first = payloads[0]?.event as { properties: { error: unknown } } | undefined;
      expect(first?.properties.error).toEqual({
        name: "APIError",
        data: { message: "You exceeded your current quota" },
      });
    });

    it("never throws into OpenCode, whatever it is handed", async () => {
      const hooks = await loadV1();
      for (const input of [
        undefined,
        null,
        {},
        { event: null },
        { event: { type: "session.idle" } },
        { event: 42 },
      ]) {
        await expect(hooks.event(input)).resolves.toBeUndefined();
      }
    });
  });

  describe("OpenCode 2.x", () => {
    it("subscribes to the events it reads and sends one per change in the captured session", async () => {
      // The order OpenCode 2.2.6 emitted them in, minus step/text/tool noise.
      const { ctx, subscribed } = contextV2(
        [
          "session-created.json",
          "session-execution-started.json",
          "session-renamed.json",
          "form-created.json",
          "form-replied.json",
          "permission-asked-edit.json",
          "permission-replied-once.json",
          "session-execution-succeeded.json",
          "session-execution-started.json",
          "permission-asked-shell.json",
          "permission-replied-reject.json",
          "session-execution-interrupted-shutdown.json",
        ].map(fixtureV2),
      );
      const cleanup = (await loadModule()).setup(ctx);
      expect(typeof cleanup).toBe("function");
      expect(subscribed[0]?.types).toEqual(
        expect.arrayContaining(["session.created", "session.renamed", "permission.asked", "form.created"]),
      );

      const payloads = await sent(10);
      expect(payloads.map((p) => (p.event as { type: string }).type)).toEqual([
        "session.execution.started",
        "form.created",
        "form.replied",
        "permission.asked",
        "permission.replied",
        "session.execution.succeeded",
        "session.execution.started",
        "permission.asked",
        "permission.replied",
        "session.execution.interrupted",
      ]);
      // The raw event carries the command; only the permission's action may leave OpenCode.
      expect(payloads[7]?.event).toEqual({
        type: "permission.asked",
        data: { sessionID: SESSION_V2, action: "shell" },
      });
      expect(payloads[0]).toMatchObject({ v: 2, directory: CWD, pid: process.pid });
      expect(payloads[0]?.title).toBeUndefined();
      expect(payloads[1]?.title).toBe("Add word to hello.txt");
      expect(statusesOf(payloads)).toEqual([
        "working",
        "needs_input",
        "working",
        "needs_input",
        "working",
        "done",
        "working",
        "needs_input",
        "working",
        "idle",
      ]);
      (cleanup as () => void)();
      expect(subscribed[0]?.signal?.aborted).toBe(true);
    });

    it("finds a question's session inside its form, and sends none of the question", async () => {
      const { ctx } = contextV2([fixtureV2("form-created.json")]);
      (await loadModule()).setup(ctx);
      const [payload] = await sent(1);
      expect(payload?.event).toEqual({ type: "form.created", data: { form: { sessionID: SESSION_V2 } } });
      expect(normalizeOpenCode(payload, { env: {}, now: new Date() })?.status).toBe("needs_input");
    });

    it("marks a subagent's events with the session the user is looking at", async () => {
      const ask = fixtureV2("permission-asked-shell.json") as { data: Record<string, unknown> };
      const { ctx } = contextV2([
        fixtureV2("session-created.json"),
        fixtureV2("session-created-child.json"),
        { ...ask, data: { ...ask.data, sessionID: "ses_v2child00000000000000000001" } },
      ]);
      (await loadModule()).setup(ctx);
      const [payload] = await sent(1);
      expect(payload).toMatchObject({ rootSessionID: SESSION_V2 });
    });

    it("never throws into OpenCode, even without an event API or with a failing stream", async () => {
      const plugin = await loadModule();
      for (const ctx of [undefined, null, {}, { event: {} }]) {
        expect(typeof plugin.setup(ctx)).toBe("function");
      }
      const failing = {
        event: {
          subscribe: () =>
            (async function* () {
              yield { type: 42 };
              throw new Error("stream closed");
            })(),
        },
      };
      expect(typeof plugin.setup(failing)).toBe("function");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readdir(outDir)).toEqual([]);
    });
  });

  it("survives a hook command that can't run", async () => {
    const plugin = await loadModule(
      `"${join(dir, "does-not-exist").replace(/\\/g, "/")}" hook --tool opencode`,
    );
    const hooks = await plugin.server({ directory: CWD });
    await expect(hooks.event({ event: fixture("session-idle.json") })).resolves.toBeUndefined();
    const { ctx } = contextV2([fixtureV2("session-execution-succeeded.json")]);
    expect(typeof plugin.setup(ctx)).toBe("function");
  });
});
