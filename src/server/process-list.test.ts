import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultListChildren, parseElapsed, parsePsList, parseWindowsList } from "./process-list.js";

describe("parsers", () => {
  it("parses PowerShell's JSON output, single object or array", () => {
    const one =
      '{"pid":5,"ppid":1,"name":"cmd.exe","cmd":"cmd /c x","created":"2026-10-16T12:00:00.0000000Z"}';
    expect(parseWindowsList(one)).toEqual([
      {
        pid: 5,
        parentPid: 1,
        name: "cmd.exe",
        command: "cmd /c x",
        startedAt: Date.parse("2026-10-16T12:00:00Z"),
      },
    ]);
    expect(parseWindowsList(`[${one},${one}]`)).toHaveLength(2);
    expect(parseWindowsList("")).toEqual([]);
    expect(parseWindowsList("[]")).toEqual([]);
  });

  it("parses ps elapsed times", () => {
    expect(parseElapsed("00:05")).toBe(5);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-00:00:01")).toBe(172801);
    expect(parseElapsed("garbage")).toBeUndefined();
  });

  it("keeps only children of the requested parents", () => {
    const out = [
      "  10     1 01:00 /bin/bash -c npm test",
      "  11     2 00:30 /usr/bin/git status",
      "junk",
    ].join("\n");
    const now = 1_000_000;
    expect(parsePsList(out, [1], now)).toEqual([
      { pid: 10, parentPid: 1, startedAt: now - 60_000, name: "bash", command: "/bin/bash -c npm test" },
    ]);
  });
});

describe("live process listing", () => {
  it("finds a child process of this test run, and answers repeat queries quickly", async () => {
    const list = defaultListChildren();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const children = await list([process.pid]);
      const found = children.find((c) => c.pid === sleeper.pid);
      expect(found).toBeDefined();
      expect(found?.parentPid).toBe(process.pid);
      expect(Math.abs((found?.startedAt ?? 0) - Date.now())).toBeLessThan(30_000);

      // On Windows the first query starts the worker; later ones reuse it and must be fast.
      const started = Date.now();
      const again = await list([process.pid]);
      expect(again.some((c) => c.pid === sleeper.pid)).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await list([])).toEqual([]);
    } finally {
      sleeper.kill();
      if ("dispose" in list && typeof list.dispose === "function") list.dispose();
    }
  }, 40_000);
});
