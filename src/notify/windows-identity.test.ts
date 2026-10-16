import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_DISPLAY_NAME } from "../core/constants.js";
import {
  parseRegQuery,
  type RegRunner,
  registerWindowsAppId,
  unregisterWindowsAppId,
  WINDOWS_APP_KEY,
} from "./windows-identity.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** An in-memory stand-in for reg.exe, so tests never touch the real registry. */
function fakeRegistry() {
  const keys = new Map<string, Map<string, string>>();
  const calls: string[][] = [];
  const reg: RegRunner = async (args) => {
    calls.push(args);
    const [command, key = ""] = args;
    const values = keys.get(key);
    switch (command) {
      case "query": {
        if (!values) return { code: 1, stdout: "" };
        const lines = [...values].map(([name, data]) => `    ${name}    REG_SZ    ${data}`);
        return { code: 0, stdout: `\r\n${key}\r\n${lines.join("\r\n")}\r\n\r\n` };
      }
      case "add": {
        const next = values ?? new Map<string, string>();
        next.set(args[args.indexOf("/v") + 1] ?? "", args[args.indexOf("/d") + 1] ?? "");
        keys.set(key, next);
        return { code: 0, stdout: "" };
      }
      case "delete":
        keys.delete(key);
        return { code: 0, stdout: "" };
      default:
        return { code: 1, stdout: "" };
    }
  };
  return { keys, calls, reg };
}

describe("parseRegQuery", () => {
  it("reads names and data, including paths with spaces and empty values", () => {
    const stdout = [
      "",
      "HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\demo",
      "    DisplayName    REG_SZ    Orchestrator",
      "    IconUri    REG_SZ    C:\\Users\\A User\\.orchestrator\\icons\\app-v1.ico",
      "    Empty    REG_SZ    ",
      "",
    ].join("\r\n");
    expect(parseRegQuery(stdout)).toEqual({
      DisplayName: "Orchestrator",
      IconUri: "C:\\Users\\A User\\.orchestrator\\icons\\app-v1.ico",
      Empty: "",
    });
  });
});

describe("Windows notification identity", () => {
  it("registers the name and icon, writes the icon, and changes nothing the second time", async () => {
    dir = await mkdtemp(join(tmpdir(), "identity-"));
    const { keys, calls, reg } = fakeRegistry();

    const first = await registerWindowsAppId({ dryRun: false, iconDir: dir, reg });
    expect(first.changed).toBe(true);
    const iconPath = join(dir, "app-v1.ico");
    expect(Object.fromEntries(keys.get(WINDOWS_APP_KEY) ?? [])).toEqual({
      DisplayName: APP_DISPLAY_NAME,
      IconUri: iconPath,
    });
    expect((await readFile(iconPath)).readUInt16LE(2)).toBe(1); // ICO header: type icon

    calls.length = 0;
    const second = await registerWindowsAppId({ dryRun: false, iconDir: dir, reg });
    expect(second).toEqual({ changed: false, summary: [] });
    expect(calls.every((c) => c[0] === "query")).toBe(true); // only looked, never wrote
  });

  it("removes the key registered under the old project name", async () => {
    dir = await mkdtemp(join(tmpdir(), "identity-"));
    const { keys, reg } = fakeRegistry();
    const legacy = "HKCU\\Software\\Classes\\AppUserModelId\\orchestrator.notifications";
    keys.set(legacy, new Map([["DisplayName", "Orchestrator"]]));

    const preview = await registerWindowsAppId({ dryRun: true, iconDir: dir, reg });
    expect(preview.summary).toContain(`remove old ${legacy}`);
    expect(keys.has(legacy)).toBe(true);

    await registerWindowsAppId({ dryRun: false, iconDir: dir, reg });
    expect(keys.has(legacy)).toBe(false);
    expect(keys.has(WINDOWS_APP_KEY)).toBe(true);

    keys.set(legacy, new Map([["DisplayName", "Orchestrator"]]));
    await unregisterWindowsAppId({ dryRun: false, reg });
    expect(keys.size).toBe(0);
  });

  it("writes nothing on a dry run", async () => {
    dir = await mkdtemp(join(tmpdir(), "identity-"));
    const { keys, reg } = fakeRegistry();
    const result = await registerWindowsAppId({ dryRun: true, iconDir: dir, reg });
    expect(result.changed).toBe(true);
    expect(result.summary).toHaveLength(2);
    expect(keys.size).toBe(0);
    await expect(readFile(join(dir, "app-v1.ico"))).rejects.toThrow();
  });

  it("uninstall removes exactly our key, and is a no-op when it is not there", async () => {
    dir = await mkdtemp(join(tmpdir(), "identity-"));
    const { keys, reg } = fakeRegistry();
    keys.set("HKCU\\Software\\Classes\\AppUserModelId\\someone.else", new Map([["DisplayName", "Other"]]));
    await registerWindowsAppId({ dryRun: false, iconDir: dir, reg });

    expect((await unregisterWindowsAppId({ dryRun: true, reg })).changed).toBe(true);
    expect(keys.has(WINDOWS_APP_KEY)).toBe(true);
    expect((await unregisterWindowsAppId({ dryRun: false, reg })).changed).toBe(true);
    expect([...keys.keys()]).toEqual(["HKCU\\Software\\Classes\\AppUserModelId\\someone.else"]);
    expect(await unregisterWindowsAppId({ dryRun: false, reg })).toEqual({ changed: false, summary: [] });
  });
});
