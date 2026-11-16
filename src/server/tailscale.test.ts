import { describe, expect, it } from "vitest";
import { resolveTailscaleExecutable } from "./tailscale.js";

const files = (...list: string[]) => {
  const set = new Set(list);
  return (file: string) => set.has(file);
};

describe("resolveTailscaleExecutable", () => {
  const installed = "C:\\Program Files\\Tailscale\\tailscale.exe";

  it("prefers the default install path on Windows", () => {
    const env = { ProgramFiles: "C:\\Program Files", Path: "C:\\tools" };
    expect(
      resolveTailscaleExecutable({
        platform: "win32",
        env,
        exists: files(installed, "C:\\tools\\tailscale.exe"),
      }),
    ).toBe(installed);
  });

  it("searches only absolute PATH entries on Windows, never the current directory", () => {
    const env = { Path: '.;;tools;C:\\bin;"C:\\quoted"' };
    expect(
      resolveTailscaleExecutable({
        platform: "win32",
        env,
        exists: files("tailscale.exe", ".\\tailscale.exe", "tools\\tailscale.exe"),
      }),
    ).toBeNull();
    expect(
      resolveTailscaleExecutable({ platform: "win32", env, exists: files("C:\\bin\\tailscale.exe") }),
    ).toBe("C:\\bin\\tailscale.exe");
    expect(
      resolveTailscaleExecutable({ platform: "win32", env, exists: files("C:\\quoted\\tailscale.exe") }),
    ).toBe("C:\\quoted\\tailscale.exe");
  });

  it("uses the app binary on macOS, then PATH", () => {
    const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    expect(
      resolveTailscaleExecutable({ platform: "darwin", env: { PATH: "/usr/bin" }, exists: files(app) }),
    ).toBe(app);
    expect(
      resolveTailscaleExecutable({
        platform: "darwin",
        env: { PATH: "/opt/bin:/usr/bin" },
        exists: files("/usr/bin/tailscale"),
      }),
    ).toBe("/usr/bin/tailscale");
  });

  it("uses PATH on Linux and returns null when absent", () => {
    expect(
      resolveTailscaleExecutable({
        platform: "linux",
        env: { PATH: "relative:/usr/sbin" },
        exists: files("relative/tailscale", "/usr/sbin/tailscale"),
      }),
    ).toBe("/usr/sbin/tailscale");
    expect(resolveTailscaleExecutable({ platform: "linux", env: {}, exists: () => false })).toBeNull();
  });
});
