import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesktopSessionResolver } from "./desktop-sessions.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentwatch-desktop-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(name: string, body: unknown, mtime = 1_700_000_000): void {
  const dir = join(root, "u1", "u2");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  utimesSync(file, mtime, mtime);
}

describe("createDesktopSessionResolver", () => {
  it("matches by cliSessionId", () => {
    record("local_a", { sessionId: "local_a", cliSessionId: "cli-1", title: "private" });
    expect(createDesktopSessionResolver(() => [root])("cli-1")).toBe("local_a");
  });

  it("matches by lastAssistantCliSessionId", () => {
    record("local_b", { sessionId: "local_b", cliSessionId: "old", lastAssistantCliSessionId: "cli-2" });
    expect(createDesktopSessionResolver(() => [root])("cli-2")).toBe("local_b");
  });

  it("prefers non-archived, then the latest", () => {
    record("local_c", { sessionId: "local_c", cliSessionId: "cli-3", isArchived: false }, 1_700_000_000);
    record("local_d", { sessionId: "local_d", cliSessionId: "cli-3", isArchived: true }, 1_800_000_000);
    record("local_e", { sessionId: "local_e", cliSessionId: "cli-3", isArchived: false }, 1_750_000_000);
    expect(createDesktopSessionResolver(() => [root])("cli-3")).toBe("local_e");
  });

  it("rejects invalid ids, ignores malformed JSON and unknown sessions", () => {
    record("local_f", { sessionId: "local_f&x=1", cliSessionId: "cli-4" });
    record("local_g", "{not json");
    record("local_h", { sessionId: "local_h", cliSessionId: "other" });
    const resolve = createDesktopSessionResolver(() => [root]);
    expect(resolve("cli-4")).toBeUndefined();
    expect(resolve("missing")).toBeUndefined();
  });

  it("remembers a miss briefly so repeated clicks do not rescan, then looks again", () => {
    let now = 1_000;
    let scans = 0;
    const resolve = createDesktopSessionResolver(
      () => {
        scans += 1;
        return [root];
      },
      () => now,
    );
    expect(resolve("cli-9")).toBeUndefined();
    expect(resolve("cli-9")).toBeUndefined();
    expect(scans).toBe(1);

    // The app writes its record a moment later.
    record("local_i", { sessionId: "local_i", cliSessionId: "cli-9" });
    now += 14_000;
    expect(resolve("cli-9")).toBeUndefined();
    expect(scans).toBe(1);
    now += 2_000;
    expect(resolve("cli-9")).toBe("local_i");
    expect(scans).toBe(2);
    expect(resolve("cli-9")).toBe("local_i");
    expect(scans).toBe(2);
  });

  it("returns undefined for a missing root and caches hits", () => {
    expect(createDesktopSessionResolver(() => [join(root, "nope")])("cli-1")).toBeUndefined();
    record("local_a", { sessionId: "local_a", cliSessionId: "cli-1" });
    const resolve = createDesktopSessionResolver(() => [root]);
    expect(resolve("cli-1")).toBe("local_a");
    rmSync(join(root, "u1"), { recursive: true });
    expect(resolve("cli-1")).toBe("local_a");
  });
});
