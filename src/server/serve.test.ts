import { describe, expect, it } from "vitest";
import { type ExecFn, type ExecResult, serveOff, serveOn, serveStatus } from "./serve.js";

const EXE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const HOST = "box.tail1234.ts.net";
const PORT = 7878;

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST}.` } });
const ours = (port = PORT) =>
  JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
  });
const other = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
});

/** Fake CLI. `serveStatus` is a function so a later call can see the effect of `serve ... on`. */
function fake(opts: { status?: string; serveStatus: () => string; onServe?: () => ExecResult }) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_file, args) => {
    calls.push(args);
    const line = args.join(" ");
    if (line === "status --json") return ok(opts.status ?? running);
    if (line === "serve status --json") return ok(opts.serveStatus());
    if (args[0] === "serve") return opts.onServe?.() ?? ok();
    throw new Error(`unexpected command: ${line}`);
  };
  return { calls, deps: { resolve: () => EXE, exec } };
}
const mutating = (calls: string[][]) => calls.filter((c) => c[0] === "serve" && c[1] !== "status");

describe("serveOn", () => {
  it("reports not_installed without running anything", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_f, a) => {
      calls.push(a);
      return ok();
    };
    const out = await serveOn({ resolve: () => null, exec }, PORT);
    expect(out.state).toBe("not_installed");
    expect(calls).toHaveLength(0);
  });

  it("reports logged_out and does not run serve", async () => {
    const { deps, calls } = fake({
      status: JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }),
      serveStatus: () => "{}",
    });
    expect((await serveOn(deps, PORT)).state).toBe("logged_out");
    expect(mutating(calls)).toHaveLength(0);
  });

  it("returns the consent URL when Tailscale asks for it", async () => {
    const { deps } = fake({
      serveStatus: () => "{}",
      onServe: () => ({
        code: null,
        stdout: "",
        stderr:
          "Serve is not enabled on your tailnet.\nTo enable, visit:\n  https://login.tailscale.com/f/serve?node=abc123\n",
        timedOut: false,
      }),
    });
    const out = await serveOn(deps, PORT);
    expect(out.state).toBe("needs_consent");
    expect(out.consentUrl).toBe("https://login.tailscale.com/f/serve?node=abc123");
  });

  it("refuses to overwrite another mapping on :443", async () => {
    const { deps, calls } = fake({ serveStatus: () => other });
    const out = await serveOn(deps, PORT);
    expect(out.state).toBe("port_in_use");
    expect(mutating(calls)).toHaveLength(0);
  });

  it("refuses when :443 has a handler we can't identify, and when Funnel is on", async () => {
    const tcpOnly = fake({
      serveStatus: () => JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }),
    });
    expect((await serveOn(tcpOnly.deps, PORT)).state).toBe("port_in_use");
    const funnel = fake({
      serveStatus: () => JSON.stringify({ ...JSON.parse(ours()), AllowFunnel: { [`${HOST}:443`]: true } }),
    });
    const out = await serveOn(funnel.deps, PORT);
    expect(out.state).toBe("error");
    expect(mutating(funnel.calls)).toHaveLength(0);
  });

  it("is idempotent when :443 already serves exactly our port", async () => {
    const { deps, calls } = fake({ serveStatus: () => ours() });
    const out = await serveOn(deps, PORT);
    expect(out).toMatchObject({ state: "on", host: HOST, created: false });
    expect(mutating(calls)).toHaveLength(0);
  });

  it("runs exactly the documented command and verifies the result", async () => {
    let enabled = false;
    const { deps, calls } = fake({
      serveStatus: () => (enabled ? ours() : "{}"),
      onServe: () => {
        enabled = true;
        return ok();
      },
    });
    const out = await serveOn(deps, PORT);
    expect(out).toMatchObject({ state: "on", host: HOST, created: true });
    expect(mutating(calls)).toEqual([["serve", "--bg", "--yes", "--https=443", `http://127.0.0.1:${PORT}`]]);
  });

  it("reports an error when the command fails", async () => {
    const { deps } = fake({
      serveStatus: () => "{}",
      onServe: () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }),
    });
    const out = await serveOn(deps, PORT);
    expect(out.state).toBe("error");
    expect(out.message).toContain("boom");
  });
});

describe("serveStatus", () => {
  it("is read-only and tells off from on", async () => {
    const off = fake({ serveStatus: () => "{}" });
    expect((await serveStatus(off.deps, PORT)).state).toBe("off");
    const on = fake({ serveStatus: () => ours() });
    expect((await serveStatus(on.deps, PORT)).state).toBe("on");
    expect(mutating(off.calls).concat(mutating(on.calls))).toHaveLength(0);
  });
});

describe("serveOff", () => {
  it("turns off only a managed mapping that still points at us", async () => {
    const { deps, calls } = fake({ serveStatus: () => ours() });
    const out = await serveOff(deps, PORT, true);
    expect(out).toMatchObject({ state: "off", turnedOff: true });
    expect(mutating(calls)).toEqual([["serve", "--https=443", "off"]]);
  });

  it("leaves a mapping it did not create", async () => {
    const { deps, calls } = fake({ serveStatus: () => ours() });
    const out = await serveOff(deps, PORT, false);
    expect(out).toMatchObject({ state: "off", turnedOff: false });
    expect(calls).toHaveLength(0);
  });

  it("leaves a managed mapping that was since changed to something else", async () => {
    const { deps, calls } = fake({ serveStatus: () => other });
    const out = await serveOff(deps, PORT, true);
    expect(out).toMatchObject({ state: "off", turnedOff: false });
    expect(mutating(calls)).toHaveLength(0);
  });
});
