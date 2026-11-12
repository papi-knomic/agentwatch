import { describe, expect, it, vi } from "vitest";
import { openUrl } from "./open.js";

function fakeSpawn() {
  const spawnFn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  return spawnFn;
}

describe("openUrl", () => {
  const url = "claude://code/continue?session=local_a&x=1";

  it("passes the URL as one argument, without a shell, so '&' is not a command separator", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const spawnFn = fakeSpawn();
      openUrl(url, spawnFn, platform);
      const [command, args, options] = spawnFn.mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(args.at(-1)).toBe(url);
      expect(options).not.toHaveProperty("shell");
      expect(command).not.toMatch(/^(cmd|powershell|sh|bash)/);
    }
  });

  it("uses the Windows URL handler directly", () => {
    const spawnFn = fakeSpawn();
    openUrl(url, spawnFn, "win32");
    expect(spawnFn.mock.calls[0]?.slice(0, 2)).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
  });
});
