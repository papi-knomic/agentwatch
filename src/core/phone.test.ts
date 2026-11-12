import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, setPhoneConfig } from "./config.js";
import {
  applyPhoneUpdate,
  defaultPhoneConfig,
  generateTopic,
  isValidTopic,
  normalizeServer,
  parsePhone,
  publicPhone,
} from "./phone.js";

const TOKEN = "0123456789abcdef0123";
const TOPIC = "abcdefghijklmnop_-ABCDEF";

describe("normalizeServer", () => {
  it("accepts https and strips the trailing slash", () => {
    expect(normalizeServer("https://ntfy.sh")).toBe("https://ntfy.sh");
    expect(normalizeServer("https://ntfy.example.com/base/")).toBe("https://ntfy.example.com/base");
  });
  it("rejects plain http except for localhost", () => {
    expect(normalizeServer("http://ntfy.example.com")).toBeNull();
    expect(normalizeServer("http://192.168.1.5")).toBeNull();
    expect(normalizeServer("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeServer("http://localhost:8080")).toBe("http://localhost:8080");
  });
  it("rejects junk, credentials and other schemes", () => {
    for (const bad of [
      "",
      "ntfy.sh",
      "ftp://x.com",
      "https://u:p@ntfy.sh",
      "https://ntfy.sh/?a=1",
      5,
      null,
    ]) {
      expect(normalizeServer(bad)).toBeNull();
    }
  });
});

describe("topics", () => {
  it("generates long random url-safe topics", () => {
    const a = generateTopic();
    expect(isValidTopic(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(22); // 128 bits in base64url
    expect(generateTopic()).not.toBe(a);
  });
  it("rejects short, long and unsafe topics", () => {
    for (const bad of ["short", "a".repeat(65), "has space 123456789012", "slash/slash/1234567890", ""]) {
      expect(isValidTopic(bad)).toBe(false);
    }
    expect(isValidTopic(TOPIC)).toBe(true);
  });
});

describe("parsePhone / parseConfig", () => {
  it("is disabled by default", () => {
    expect(parseConfig({ token: TOKEN }, {})?.phone).toEqual(defaultPhoneConfig());
    expect(defaultPhoneConfig().enabled).toBe(false);
    expect(defaultPhoneConfig().includeDetails).toBe(false);
  });
  it("falls back from a bad server and stays off without a valid topic", () => {
    const phone = parsePhone({ enabled: true, server: "http://evil.example", topic: "short" });
    expect(phone.server).toBe("https://ntfy.sh");
    expect(phone.enabled).toBe(false);
    expect(phone.topic).toBe("");
  });
  it("keeps valid settings", () => {
    const phone = parsePhone({
      enabled: true,
      server: "https://n.example.com",
      topic: TOPIC,
      token: " tk_x ",
      includeDetails: true,
    });
    expect(phone).toEqual({
      enabled: true,
      server: "https://n.example.com",
      topic: TOPIC,
      token: "tk_x",
      includeDetails: true,
    });
  });
});

describe("applyPhoneUpdate", () => {
  it("generates a topic when enabling without one", () => {
    const next = applyPhoneUpdate(defaultPhoneConfig(), { enabled: true });
    expect(next.enabled).toBe(true);
    expect(isValidTopic(next.topic)).toBe(true);
  });
  it("keeps the topic when it already has one, and regenerates on request", () => {
    const base = { ...defaultPhoneConfig(), topic: TOPIC };
    expect(applyPhoneUpdate(base, { enabled: true }).topic).toBe(TOPIC);
    expect(applyPhoneUpdate(base, { regenerateTopic: true }).topic).not.toBe(TOPIC);
  });
  it("rejects a bad server and bad types", () => {
    expect(() => applyPhoneUpdate(defaultPhoneConfig(), { server: "http://example.com" })).toThrow(/https/);
    expect(() => applyPhoneUpdate(defaultPhoneConfig(), { enabled: "yes" })).toThrow();
    expect(() => applyPhoneUpdate(defaultPhoneConfig(), { includeDetails: 1 })).toThrow();
  });
  it("keeps, sets and clears the token", () => {
    const withToken = applyPhoneUpdate(defaultPhoneConfig(), { token: "tk_secret" });
    expect(withToken.token).toBe("tk_secret");
    expect(applyPhoneUpdate(withToken, { includeDetails: true }).token).toBe("tk_secret");
    expect(applyPhoneUpdate(withToken, { token: "" }).token).toBeUndefined();
  });
  it("never exposes the token to the browser", () => {
    const view = publicPhone({ ...defaultPhoneConfig(), topic: TOPIC, token: "tk_secret" });
    expect(JSON.stringify(view)).not.toContain("tk_secret");
    expect(view.tokenSet).toBe(true);
  });
});

describe("setPhoneConfig", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-phone-"));
    env = { AGENTWATCH_HOME: home };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("changes only the phone key", async () => {
    const file = join(home, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        port: 1234,
        token: TOKEN,
        custom: { keep: 1 },
        remote: { enabled: false, hosts: [] },
      }),
    );
    const phone = { ...defaultPhoneConfig(), topic: TOPIC, enabled: true };
    expect(await setPhoneConfig(phone, env)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      port: 1234,
      token: TOKEN,
      custom: { keep: 1 },
      remote: { enabled: false, hosts: [] },
      phone,
    });
  });
  it("does nothing without a config file", async () => {
    expect(await setPhoneConfig(defaultPhoneConfig(), env)).toBe(false);
  });
});
