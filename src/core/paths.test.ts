import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appHome, canonicalPath } from "./paths.js";

describe("app home", () => {
  it("uses the override, then ~/.agentwatch", () => {
    expect(appHome({ AGENTWATCH_HOME: "/custom" }, "/home/dev")).toBe("/custom");
    expect(appHome({}, "/home/dev")).toBe(join("/home/dev", ".agentwatch"));
  });
});

describe("canonicalPath", () => {
  it("returns the on-disk spelling of an existing folder, and the input otherwise", () => {
    expect(canonicalPath(process.cwd().toUpperCase())).toBe(
      process.platform === "win32" ? process.cwd() : process.cwd().toUpperCase(),
    );
    expect(canonicalPath("/definitely/not/here")).toBe("/definitely/not/here");
  });
});
