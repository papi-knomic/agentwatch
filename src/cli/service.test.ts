import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertStableInstall } from "./service.js";

describe("assertStableInstall", () => {
  it("refuses npx's temporary cache, which npm may clear", () => {
    const npx = join(
      "C:",
      "Users",
      "dev",
      "AppData",
      "Local",
      "npm-cache",
      "_npx",
      "a1b2",
      "node_modules",
      "x.js",
    );
    expect(() => assertStableInstall(npx)).toThrow(/npm install -g agentwatch/);
  });

  it("accepts a global install or a local checkout", () => {
    expect(() =>
      assertStableInstall(join("C:", "nvm4w", "nodejs", "node_modules", "agentwatch", "x.js")),
    ).not.toThrow();
    expect(() =>
      assertStableInstall(join("C:", "research", "orchestrator", "dist", "cli", "index.js")),
    ).not.toThrow();
  });
});
