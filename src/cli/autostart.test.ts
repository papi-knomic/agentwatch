import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autostartFor, launchdPlist, windowsRunCommand, xdgDesktopEntry } from "./autostart.js";

const target = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\agentwatch\\dist\\cli\\index.js",
  homeDir: "",
};

describe("autostart commands", () => {
  it("launches through conhost --headless on Windows, with quoted paths", () => {
    expect(windowsRunCommand(target, "C:\\Windows")).toBe(
      '"C:\\Windows\\System32\\conhost.exe" --headless "C:\\Program Files\\nodejs\\node.exe" ' +
        '"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\agentwatch\\dist\\cli\\index.js" start --background',
    );
  });

  it("builds a LaunchAgent that runs at load", () => {
    const plist = launchdPlist({ ...target, nodePath: "/usr/local/bin/node", cliPath: "/opt/a&b/cli.js" });
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/a&amp;b/cli.js</string>");
    expect(plist).toContain("<string>--background</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  it("quotes Exec arguments in the XDG desktop entry", () => {
    const entry = xdgDesktopEntry({ ...target, nodePath: "/usr/bin/node", cliPath: '/home/d/my "x"/cli.js' });
    expect(entry).toContain('Exec="/usr/bin/node" "/home/d/my \\"x\\"/cli.js" start --background');
  });
});

describe.each(["darwin", "linux"] as const)("file-based autostart on %s", (platform) => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-autostart-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("installs once, reports it, and uninstalls cleanly", async () => {
    const entry = autostartFor(platform, { ...target, homeDir: home });
    expect(entry.location.startsWith(home)).toBe(true);
    expect(await entry.isInstalled()).toBe(false);

    expect((await entry.install(true)).changed).toBe(true);
    expect(await entry.isInstalled()).toBe(false); // dry run wrote nothing

    expect((await entry.install(false)).changed).toBe(true);
    expect(await entry.isInstalled()).toBe(true);
    expect(await readFile(entry.location, "utf8")).toContain("--background");
    expect((await entry.install(false)).changed).toBe(false);

    expect((await entry.uninstall(false)).changed).toBe(true);
    expect(await entry.isInstalled()).toBe(false);
    expect((await entry.uninstall(false)).changed).toBe(false);
  });
});
