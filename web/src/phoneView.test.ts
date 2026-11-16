import { describe, expect, it } from "vitest";
import {
  lastSeen,
  ntfyServerLabel,
  ntfySubscribeUrl,
  pairedSummary,
  remoteView,
  stepStates,
} from "./phoneView";
import type { PairedDevice, RemoteSettings, ServeOutcome } from "./remote";

const HOST = "box.tail1234.ts.net";
const on: RemoteSettings = { enabled: true, hosts: [HOST], port: 7878 };
const off: RemoteSettings = { enabled: false, hosts: [], port: 7878 };
const device = (name: string): PairedDevice => ({
  id: name,
  name,
  createdAt: "2026-01-01T00:00:00Z",
  lastSeenAt: "2026-01-01T00:00:00Z",
  allowApprovals: false,
});
const serveOn: ServeOutcome = { state: "on", host: HOST };

describe("remoteView", () => {
  it("is on when the server's remote switch is on, whatever the wizard did earlier", () => {
    const view = remoteView(on, serveOn, []);
    expect(view).toMatchObject({ on: true, host: HOST, address: `https://${HOST}`, mappingMissing: false });
  });

  it("is off with no address when the switch is off", () => {
    expect(remoteView(off, { state: "off" }, [])).toMatchObject({ on: false, address: null });
    expect(remoteView(null, null, [])).toMatchObject({ on: false, paired: false });
  });

  it("flags a config that is on while Tailscale has no mapping", () => {
    expect(remoteView(on, { state: "off" }, []).mappingMissing).toBe(true);
  });

  it("counts a paired phone only while access is on", () => {
    expect(remoteView(on, serveOn, [device("iPhone")]).paired).toBe(true);
    expect(remoteView(off, null, [device("iPhone")]).paired).toBe(false);
  });
});

describe("stepStates", () => {
  it("walks from step 1 to done", () => {
    expect(stepStates(remoteView(off, null, []))).toEqual(["current", "todo", "blocked"]);
    expect(stepStates(remoteView(on, serveOn, []))).toEqual(["done", "current", "current"]);
    expect(stepStates(remoteView(on, serveOn, [device("iPhone")]))).toEqual(["done", "done", "done"]);
  });
});

describe("ntfy links", () => {
  it("uses an https link, never ntfy://", () => {
    expect(ntfySubscribeUrl("https://ntfy.sh/", "abc")).toBe("https://ntfy.sh/abc");
    expect(ntfySubscribeUrl("https://ntfy.example.com/base", "abc")).toBe(
      "https://ntfy.example.com/base/abc",
    );
  });

  it("labels the server by host", () => {
    expect(ntfyServerLabel("https://ntfy.sh")).toBe("ntfy.sh");
    expect(ntfyServerLabel("not a url")).toBe("not a url");
  });
});

describe("text helpers", () => {
  it("says when a phone was last seen", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(lastSeen("2026-01-01T11:59:40Z", now)).toBe("just now");
    expect(lastSeen("2026-01-01T11:55:00Z", now)).toBe("5 min ago");
    expect(lastSeen("2026-01-01T09:00:00Z", now)).toBe("3 h ago");
    expect(lastSeen("2025-12-30T12:00:00Z", now)).toBe("2 d ago");
    expect(lastSeen("nope", now)).toBe("never");
  });

  it("summarises paired names", () => {
    expect(pairedSummary(["iPhone"])).toBe("iPhone");
    expect(pairedSummary(["a", "b", "c", "d"])).toBe("a, b and 2 more");
  });
});
