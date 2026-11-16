import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginSource } from "./plugin.js";

// Loads the generated plugin the way OpenCode would, with `decide` replaced by a stub process, and checks what it
// sends there and what it replies to OpenCode.

interface Hooks {
  event: (input: unknown) => Promise<void>;
  dispose?: () => Promise<void>;
}
interface PluginModule {
  server: (input: unknown) => Promise<Hooks>;
  setup: (ctx: unknown) => unknown;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));
const fixtureV2 = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}`, import.meta.url), "utf8"));

const CWD = "C:\\Users\\dev\\projects\\web";
const ROOT = "ses_ea930fb5affekKS0B120gDMDYx";
const PERMISSION = "per_156cf6b46001QW30zstIuMk7lZ";
const slash = (path: string) => path.replace(/\\/g, "/");

// Stands in for `agentwatch decide`: records stdin and its pid, then prints the canned answer (or hangs).
const DECIDE_STUB = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  writeFileSync(join(dir, "decide-" + payload.requestId + ".json"), JSON.stringify({ pid: process.pid, payload }));
  if (existsSync(join(dir, "hang"))) {
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(readFileSync(join(dir, "answer.txt"), "utf8") + "\\n");
});
`;

let dir: string;
let calls: Array<{ url: string; body: unknown }>;

async function importSource(source: string): Promise<PluginModule> {
  const file = join(dir, `plugin-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, source);
  return ((await import(pathToFileURL(file).href)) as { default: PluginModule }).default;
}

const decideSource = () =>
  pluginSource('node "/x/cli.js" hook --tool opencode', {
    decide: true,
    decideCommand: `node "${slash(join(dir, "decide.mjs"))}" "${slash(dir)}" decide --tool opencode`,
  });

async function load(answer: string | null, options: { fail?: boolean } = {}): Promise<Hooks> {
  await writeFile(join(dir, "decide.mjs"), DECIDE_STUB);
  if (answer === null) await writeFile(join(dir, "hang"), "");
  else await writeFile(join(dir, "answer.txt"), answer);
  const plugin = await importSource(decideSource());
  const client = {
    _client: {
      post: async (request: { url: string; body: unknown }) => {
        calls.push({ url: request.url, body: request.body });
        if (options.fail) throw new Error("server gone");
        return { data: true };
      },
    },
  };
  return plugin.server({ directory: CWD, client });
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = await check();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const replied = () => waitFor(() => (calls.length > 0 ? true : undefined));
const readDecide = (id: string) =>
  waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(dir, `decide-${id}.json`), "utf8")) as {
        pid: number;
        payload: Record<string, unknown>;
      };
    } catch {
      return undefined;
    }
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const repliedEvent = (reply: string) => ({
  type: "permission.replied",
  properties: { sessionID: ROOT, requestID: PERMISSION, reply },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-opencode-decide-"));
  calls = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OpenCode plugin answering from the dashboard", { timeout: 40_000 }, () => {
  it("replies to OpenCode for the original request, as once, with only what the dashboard shows sent to decide", async () => {
    const hooks = await load('{"reply":"once"}');
    await hooks.event({ event: fixture("permission-asked-bash.json") });
    const { payload } = await readDecide(PERMISSION);
    // No metadata, no tool call ids, no always-patterns.
    expect(payload).toEqual({
      kind: "permission",
      sessionId: ROOT,
      requestId: PERMISSION,
      toolName: "bash",
      preview: "cmd /c dir",
    });
    await replied();
    expect(calls).toEqual([{ url: `/permission/${PERMISSION}/reply`, body: { reply: "once" } }]);
  });

  it("shows the root session but replies with the subagent's own session and request", async () => {
    const hooks = await load('{"reply":"reject"}');
    await hooks.event({ event: fixture("session-created.json") });
    await hooks.event({ event: fixture("session-created-child.json") });
    const ask = fixture("permission-asked-bash.json") as { properties: Record<string, unknown> };
    await hooks.event({
      event: { ...ask, properties: { ...ask.properties, sessionID: "ses_child00000000000000000001" } },
    });
    const { payload } = await readDecide(PERMISSION);
    expect(payload).toMatchObject({ sessionId: ROOT, agentSessionId: "ses_child00000000000000000001" });
    await replied();
    expect(calls).toEqual([{ url: `/permission/${PERMISSION}/reply`, body: { reply: "reject" } }]);
  });

  it("answers a question with one list of labels per question and sends its text whole", async () => {
    const hooks = await load('{"answers":[["Blue"]]}');
    await hooks.event({ event: fixture("question-asked.json") });
    const { payload } = await readDecide("que_156cfb128001syZq1r42zevPk2");
    expect(payload).toMatchObject({
      kind: "question",
      questions: [{ question: "Which colour should I write to `hello.txt`?", multiple: false }],
    });
    await replied();
    expect(calls).toEqual([
      { url: "/question/que_156cfb128001syZq1r42zevPk2/reply", body: { answers: [["Blue"]] } },
    ]);
  });

  it("ignores an answer it doesn't understand, never sending a standing 'always'", async () => {
    const hooks = await load('{"reply":"always"}');
    await hooks.event({ event: fixture("permission-asked-bash.json") });
    await readDecide(PERMISSION);
    await pause(600);
    expect(calls).toEqual([]);
  });

  it("stops waiting when the prompt was answered in OpenCode first", async () => {
    const hooks = await load(null);
    await hooks.event({ event: fixture("permission-asked-bash.json") });
    const { pid } = await readDecide(PERMISSION);
    expect(alive(pid)).toBe(true);
    await hooks.event({ event: repliedEvent("once") });
    await waitFor(() => (alive(pid) ? undefined : true));
    expect(calls).toEqual([]);
  });

  it("never starts the process when the prompt is answered within the start delay", async () => {
    const hooks = await load('{"reply":"once"}');
    await hooks.event({ event: fixture("permission-asked-bash.json") });
    await hooks.event({ event: repliedEvent("reject") });
    await pause(1200);
    expect(calls).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.startsWith("decide-per"))).toEqual([]);
  });

  it("runs at most five waiting processes at once", async () => {
    const hooks = await load(null);
    const ask = fixture("permission-asked-bash.json") as { properties: Record<string, unknown> };
    for (let i = 0; i < 7; i++) {
      await hooks.event({ event: { ...ask, properties: { ...ask.properties, id: `per_cap${i}` } } });
    }
    await pause(2500);
    expect((await readdir(dir)).filter((f) => f.startsWith("decide-per_cap"))).toHaveLength(5);
    await hooks.dispose?.();
  });

  it("swallows a failing reply and a decide command that can't run", async () => {
    const hooks = await load('{"reply":"once"}', { fail: true });
    await expect(hooks.event({ event: fixture("permission-asked-bash.json") })).resolves.toBeUndefined();
    await replied();

    const plugin = await importSource(
      pluginSource('node "/x/cli.js" hook --tool opencode', {
        decide: true,
        decideCommand: `"${slash(join(dir, "does-not-exist"))}" decide --tool opencode`,
      }),
    );
    const broken = await plugin.server({ directory: CWD, client: {} });
    await expect(broken.event({ event: fixture("permission-asked-bash.json") })).resolves.toBeUndefined();
    await pause(800);
  });

  it("starts nothing unless answering from the dashboard was installed", async () => {
    const source = pluginSource('node "/x/cli.js" hook --tool opencode');
    expect(source).toContain("const DECIDE = null;");
    const plugin = await importSource(source);
    const hooks = await plugin.server({
      directory: CWD,
      client: { _client: { post: async () => calls.push({ url: "x", body: 1 }) } },
    });
    await hooks.event({ event: fixture("permission-asked-bash.json") });
    await pause(800);
    expect(calls).toEqual([]);
  });

  it("on 2.x replies through ctx.permission.reply for the permission's own session and id", async () => {
    await writeFile(join(dir, "decide.mjs"), DECIDE_STUB);
    await writeFile(join(dir, "answer.txt"), '{"reply":"once"}');
    const plugin = await importSource(decideSource());
    const replies: unknown[] = [];
    const ctx = {
      location: { directory: CWD },
      permission: { reply: async (input: unknown) => replies.push(input) },
      event: {
        subscribe: () =>
          (async function* () {
            yield fixtureV2("permission-asked-shell.json");
            await pause(5000);
          })(),
      },
    };
    const cleanup = plugin.setup(ctx) as () => void;
    await waitFor(() => (replies.length > 0 ? true : undefined));
    expect(replies).toEqual([
      {
        sessionID: "ses_e40543cc2ffewW3gz0p0TD4jA8",
        requestID: "per_1bfac4c4e0016J6kBAabJGOyKl",
        decision: "once",
      },
    ]);
    cleanup();
  });
});
