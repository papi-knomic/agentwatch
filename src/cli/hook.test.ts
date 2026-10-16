import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_ENV_VAR } from "../core/constants.js";
import { runHook } from "./hook.js";

const STOP = JSON.stringify({ session_id: "s1", cwd: "C:\\projects\\demo", hook_event_name: "Stop" });
const TOKEN = "hook-test-token-0123456789";

let home: string;
const previousHome = process.env[HOME_ENV_VAR];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "orch-hook-"));
  process.env[HOME_ENV_VAR] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env[HOME_ENV_VAR];
  else process.env[HOME_ENV_VAR] = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(port: number): Promise<void> {
  await writeFile(join(home, "config.json"), JSON.stringify({ port, token: TOKEN }));
}

describe("runHook", () => {
  it("never throws, whatever it is given", async () => {
    await expect(runHook(undefined, STOP)).resolves.toBeUndefined();
    await expect(runHook("unknown-tool", STOP)).resolves.toBeUndefined();
    await expect(runHook("claude-code", "{ not json")).resolves.toBeUndefined();
    await expect(runHook("claude-code", STOP)).resolves.toBeUndefined(); // no config yet
  });

  it("returns quickly when the server is not running", async () => {
    await writeConfig(1); // nothing listens on port 1
    const started = Date.now();
    await runHook("claude-code", STOP);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  describe("with a server", () => {
    let server: Server;
    let received: { auth: string | undefined; body: unknown }[];

    beforeEach(async () => {
      received = [];
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
          res.writeHead(202).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      await writeConfig((server.address() as AddressInfo).port);
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("posts the normalized event with the token", async () => {
      await runHook("claude-code", STOP);
      expect(received).toHaveLength(1);
      expect(received[0]?.auth).toBe(`Bearer ${TOKEN}`);
      expect(received[0]?.body).toMatchObject({ tool: "claude-code", sessionId: "s1", status: "done" });
    });

    it("tolerates a leading byte-order mark", async () => {
      await runHook("claude-code", `﻿${STOP}`);
      expect(received).toHaveLength(1);
    });

    it("sends nothing for events the adapter ignores", async () => {
      await runHook(
        "claude-code",
        JSON.stringify({ session_id: "s1", cwd: "/x", hook_event_name: "PreCompact" }),
      );
      expect(received).toEqual([]);
    });

    it("drops the task title when taskTitles is off", async () => {
      const port = (server.address() as AddressInfo).port;
      const prompt = JSON.stringify({
        session_id: "s1",
        cwd: "C:\\projects\\demo",
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the login bug",
      });
      await runHook("claude-code", prompt);
      expect(received[0]?.body).toMatchObject({ title: "Fix the login bug" });

      await writeFile(join(home, "config.json"), JSON.stringify({ port, token: TOKEN, taskTitles: false }));
      await runHook("claude-code", prompt);
      expect(received[1]?.body).not.toHaveProperty("title");
      expect(JSON.stringify(received[1]?.body)).not.toContain("login");
    });

    it("sends nothing when the tool is disabled in config", async () => {
      const port = (server.address() as AddressInfo).port;
      await writeFile(
        join(home, "config.json"),
        JSON.stringify({ port, token: TOKEN, tools: { "claude-code": { enabled: false } } }),
      );
      await runHook("claude-code", STOP);
      expect(received).toEqual([]);
    });

    it("keeps Codex helper and question flags when task titles are disabled", async () => {
      const port = (server.address() as AddressInfo).port;
      await writeFile(join(home, "config.json"), JSON.stringify({ port, token: TOKEN, taskTitles: false }));
      await runHook(
        "codex",
        JSON.stringify({
          session_id: "helper",
          cwd: "/project",
          hook_event_name: "UserPromptSubmit",
          prompt: "This is an app-generated request for a suggested next user message.\nPrivate context",
        }),
      );
      await runHook(
        "codex",
        JSON.stringify({
          session_id: "real",
          cwd: "/project",
          hook_event_name: "PostToolUse",
          tool_name: "request_user_input_async",
          tool_input: { questions: ["Private question"] },
        }),
      );
      expect(received[0]?.body).toMatchObject({ hidden: true });
      expect(received[1]?.body).toMatchObject({ inputPending: true, status: "needs_input" });
      expect(JSON.stringify(received)).not.toMatch(/Private|app-generated|questions/);
    });
  });
});
