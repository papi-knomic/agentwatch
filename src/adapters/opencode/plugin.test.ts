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

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const CWD = "C:\\Users\\dev\\projects\\web";
// Stands in for `agentwatch hook`: argv[2] is where to write, the last argument is the payload.
const SINK = `import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
writeFileSync(join(process.argv[2], randomUUID() + ".json"), process.argv[process.argv.length - 1]);
`;

let dir: string;
let outDir: string;

async function loadPlugin(name = "agentwatch.mjs"): Promise<Hooks> {
  const sink = join(dir, "sink.mjs").replace(/\\/g, "/");
  const out = outDir.replace(/\\/g, "/");
  const file = join(dir, name);
  await writeFile(file, pluginSource(`node "${sink}" "${out}" hook --tool opencode`));
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const exported = Object.values(mod);
  // OpenCode treats every exported function as a plugin.
  expect(exported).toHaveLength(1);
  const plugin = exported[0] as (input: { directory: string }) => Promise<Hooks>;
  return plugin({ directory: CWD });
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

  it("sends one cut-down event per change in the captured session", async () => {
    const hooks = await loadPlugin();
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
      directory: CWD,
      pid: process.pid,
      title: expect.stringMatching(/^New session/),
    });
    expect(payloads[1]?.title).toBe('Adding "world" to hello.txt');

    const statuses = payloads.map((p) => normalizeOpenCode(p, { env: {}, now: new Date() })?.status);
    expect(statuses).toEqual(["working", "working", "needs_input", "working", "working", "done"]);
  });

  it("marks a subagent's events with the session the user is looking at", async () => {
    const hooks = await loadPlugin();
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
    const hooks = await loadPlugin();
    await hooks.event({ event: fixture("session-error.json") });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await hooks.event({ event: fixture("session-idle.json") });
    const payloads = await sent(2);
    expect(payloads[1]).toMatchObject({ afterError: "APIError" });
    const first = payloads[0]?.event as { properties: { error: unknown } } | undefined;
    const error = first?.properties.error;
    expect(error).toEqual({ name: "APIError", data: { message: "You exceeded your current quota" } });
  });

  it("never throws into OpenCode, whatever it is handed", async () => {
    const hooks = await loadPlugin();
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

  it("survives a hook command that can't run", async () => {
    const file = join(dir, "broken.mjs");
    await writeFile(
      file,
      pluginSource(`"${join(dir, "does-not-exist").replace(/\\/g, "/")}" hook --tool opencode`),
    );
    const mod = (await import(pathToFileURL(file).href)) as Record<
      string,
      (input: unknown) => Promise<Hooks>
    >;
    const hooks = await Object.values(mod)[0]?.({ directory: CWD });
    await expect(hooks?.event({ event: fixture("session-idle.json") })).resolves.toBeUndefined();
  });
});
