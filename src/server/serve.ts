import { spawn } from "node:child_process";
import { normalizeRemoteHost } from "../core/config.js";
import { resolveTailscaleExecutable } from "./tailscale.js";

/**
 * Runs Tailscale Serve for the user, on an explicit click in the dashboard (AGENTS.md hard rule 2). The only
 * commands this module may run, and nothing else, ever (no `reset`, no `funnel`):
 *   tailscale status --json
 *   tailscale serve status --json
 *   tailscale serve --bg --yes --https=443 http://127.0.0.1:<port>
 *   tailscale serve --https=443 off
 */

export interface ExecResult {
  /** null when the process was killed (timeout or consent URL seen). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Kill the process as soon as the combined output matches (used to catch the HTTPS consent URL). */
  killWhen?: RegExp;
}

export type ExecFn = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export interface ServeDeps {
  resolve: () => string | null;
  exec: ExecFn;
}

/** Real process runner: absolute path, no shell, hidden window, output capped. */
export const execTailscale: ExecFn = (file, args, { timeoutMs, killWhen }) =>
  new Promise((done) => {
    const MAX = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Don't wait for 'close': a killed process can keep pipes open on Windows.
      setTimeout(() => finish(null), 200).unref();
    }, timeoutMs);
    const onData = (which: "out" | "err") => (chunk: Buffer) => {
      if (which === "out" && stdout.length < MAX) stdout += chunk.toString("utf8");
      if (which === "err" && stderr.length < MAX) stderr += chunk.toString("utf8");
      if (killWhen?.test(`${stdout}\n${stderr}`)) {
        child.kill();
        setTimeout(() => finish(null), 200).unref();
      }
    };
    child.stdout.on("data", onData("out"));
    child.stderr.on("data", onData("err"));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

export function defaultServeDeps(): ServeDeps {
  return { resolve: resolveTailscaleExecutable, exec: execTailscale };
}

export type ServeState =
  | "not_installed"
  | "logged_out"
  | "needs_consent"
  | "port_in_use"
  | "on"
  | "off"
  | "error";

export interface ServeOutcome {
  state: ServeState;
  /** This machine's Tailscale name (no trailing dot) when known. */
  host?: string;
  consentUrl?: string;
  message?: string;
  /** on: this call created the mapping (so AgentWatch may later remove it). */
  created?: boolean;
  /** off: this call actually ran `serve off`. */
  turnedOff?: boolean;
}

const CONSENT_URL = /https:\/\/login\.tailscale\.com\/[^\s"'<>)]*/;
const STATUS_TIMEOUT_MS = 5000;
const SERVE_TIMEOUT_MS = 20_000;
const HTTPS_PORT = 443;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

interface TailnetInfo {
  host: string;
}

/** `tailscale status --json`: logged in, and what is this machine called. Returns an outcome when not ready. */
async function readTailnet(deps: ServeDeps, executable: string): Promise<TailnetInfo | ServeOutcome> {
  const res = await deps.exec(executable, ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {
      state: "error",
      message: `Couldn't read Tailscale's status. Is Tailscale running?${res.stderr ? ` (${clip(res.stderr)})` : ""}`,
    };
  }
  const root = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown };
  };
  if (root.BackendState === "NeedsLogin" || root.BackendState === "NoState") return { state: "logged_out" };
  if (root.BackendState === "Stopped")
    return { state: "error", message: "Tailscale is turned off. Turn it on, then try again." };
  const dns = typeof root.Self?.DNSName === "string" ? root.Self.DNSName.replace(/\.$/, "") : "";
  const host = normalizeRemoteHost(dns);
  if (!host) return { state: "logged_out" };
  return { host };
}

type Mapping = "free" | "ours" | "other" | "funnel";

/**
 * Looks at what :443 serves in `tailscale serve status --json`. The shape is Tailscale's ipn.ServeConfig:
 * https://github.com/tailscale/tailscale/blob/main/ipn/serve.go  (TCP: port -> {HTTPS}, Web: "host:port" ->
 * {Handlers: mountPoint -> {Proxy|Path|Text|Redirect}}, AllowFunnel: "host:port" -> bool). Parsed defensively: anything
 * unexpected counts as "other", which we never overwrite.
 */
export function classifyHttps443(status: unknown, port: number): Mapping {
  if (typeof status !== "object" || status === null) return "other";
  const cfg = status as { TCP?: unknown; Web?: unknown; AllowFunnel?: unknown };
  const tcp = typeof cfg.TCP === "object" && cfg.TCP !== null ? (cfg.TCP as Record<string, unknown>) : {};
  const web = typeof cfg.Web === "object" && cfg.Web !== null ? (cfg.Web as Record<string, unknown>) : {};
  const funnel =
    typeof cfg.AllowFunnel === "object" && cfg.AllowFunnel !== null
      ? (cfg.AllowFunnel as Record<string, unknown>)
      : {};
  const webKeys = Object.keys(web).filter((k) => k.endsWith(`:${HTTPS_PORT}`));
  if (!(String(HTTPS_PORT) in tcp) && webKeys.length === 0) return "free";
  if (webKeys.length !== 1) return "other";
  const key = webKeys[0] ?? "";
  const handlers = (web[key] as { Handlers?: unknown } | null)?.Handlers;
  if (typeof handlers !== "object" || handlers === null) return "other";
  const entries = Object.entries(handlers as Record<string, unknown>);
  if (entries.length !== 1) return "other";
  const [mount, handler] = entries[0] ?? ["", null];
  const proxy = (handler as { Proxy?: unknown } | null)?.Proxy;
  const ours = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const proxyOk = typeof proxy === "string" && ours.includes(proxy.replace(/\/+$/, ""));
  if (mount !== "/" || !proxyOk) return "other";
  // Ours, but reachable from the public internet: never call that "on".
  return funnel[key] === true ? "funnel" : "ours";
}

async function readMapping(
  deps: ServeDeps,
  executable: string,
  port: number,
): Promise<Mapping | ServeOutcome> {
  const res = await deps.exec(executable, ["serve", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  if (res.code !== 0)
    return { state: "error", message: `Couldn't read Tailscale Serve's status.${tail(res.stderr)}` };
  const text = res.stdout.trim();
  if (text === "") return "free";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "error", message: "Couldn't read Tailscale Serve's status (unexpected output)." };
  }
  return classifyHttps443(parsed, port);
}

function tail(stderr: string): string {
  return stderr.trim() ? ` (${clip(stderr)})` : "";
}

const IN_USE =
  "Tailscale Serve already uses HTTPS port 443 for something else. AgentWatch won't overwrite it. Remove that mapping in Tailscale first, or set the host up by hand.";
const FUNNEL =
  "Tailscale Funnel is on for this address, which makes it public. AgentWatch never uses Funnel: turn it off in Tailscale, then try again.";

/** Read-only: what the wizard's first step should show. Never changes anything. */
export async function serveStatus(deps: ServeDeps, port: number): Promise<ServeOutcome> {
  const executable = deps.resolve();
  if (!executable) return { state: "not_installed" };
  const tailnet = await readTailnet(deps, executable);
  if (!("host" in tailnet)) return tailnet;
  const mapping = await readMapping(deps, executable, port);
  if (typeof mapping === "object") return mapping;
  if (mapping === "ours") return { state: "on", host: tailnet.host };
  if (mapping === "funnel") return { state: "error", host: tailnet.host, message: FUNNEL };
  if (mapping === "other") return { state: "port_in_use", host: tailnet.host, message: IN_USE };
  return { state: "off", host: tailnet.host };
}

/** `serve --bg --yes --https=443 http://127.0.0.1:<port>`, only after an explicit click. */
export async function serveOn(deps: ServeDeps, port: number): Promise<ServeOutcome> {
  const executable = deps.resolve();
  if (!executable) return { state: "not_installed" };
  const tailnet = await readTailnet(deps, executable);
  if (!("host" in tailnet)) return tailnet;
  const { host } = tailnet;
  const before = await readMapping(deps, executable, port);
  if (typeof before === "object") return before;
  if (before === "ours") return { state: "on", host, created: false };
  if (before === "funnel") return { state: "error", host, message: FUNNEL };
  if (before === "other") return { state: "port_in_use", host, message: IN_USE };

  const res = await deps.exec(
    executable,
    ["serve", "--bg", "--yes", `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`],
    { timeoutMs: SERVE_TIMEOUT_MS, killWhen: CONSENT_URL },
  );
  const consent = CONSENT_URL.exec(`${res.stdout}\n${res.stderr}`)?.[0];
  if (consent) return { state: "needs_consent", host, consentUrl: consent.replace(/[.,;]+$/, "") };
  if (res.timedOut)
    return { state: "error", host, message: "Tailscale didn't answer in time. Try again in a moment." };
  if (res.code !== 0)
    return {
      state: "error",
      host,
      message: `Tailscale couldn't turn Serve on.${tail(res.stderr || res.stdout)}`,
    };

  // Trust but verify: the mapping must now be exactly ours.
  const after = await readMapping(deps, executable, port);
  if (after !== "ours")
    return {
      state: "error",
      host,
      message: "Tailscale accepted the command but Serve doesn't show the mapping.",
    };
  return { state: "on", host, created: true };
}

/**
 * `serve --https=443 off`, and only for a mapping AgentWatch created (`managed`) that still points at our port.
 * Anything else is left alone and explained.
 */
export async function serveOff(deps: ServeDeps, port: number, managed: boolean): Promise<ServeOutcome> {
  if (!managed)
    return {
      state: "off",
      turnedOff: false,
      message: "Phone access is off. Tailscale Serve was set up outside AgentWatch, so it was left as it is.",
    };
  const executable = deps.resolve();
  if (!executable)
    return {
      state: "off",
      turnedOff: false,
      message: "Phone access is off. Tailscale wasn't found to change.",
    };
  const mapping = await readMapping(deps, executable, port);
  if (typeof mapping === "object")
    return {
      state: "error",
      message: `Phone access is off here, but Serve was not changed. ${mapping.message ?? ""}`.trim(),
    };
  if (mapping !== "ours" && mapping !== "funnel")
    return {
      state: "off",
      turnedOff: false,
      message:
        mapping === "free"
          ? "Phone access is off. Tailscale Serve was already off."
          : "Phone access is off. Tailscale Serve now points somewhere else, so it was left as it is.",
    };
  const res = await deps.exec(executable, ["serve", `--https=${HTTPS_PORT}`, "off"], {
    timeoutMs: STATUS_TIMEOUT_MS * 2,
  });
  if (res.code !== 0)
    return {
      state: "error",
      message: `Phone access is off here, but Tailscale couldn't remove the Serve mapping.${tail(res.stderr)}`,
    };
  return { state: "off", turnedOff: true };
}

export interface ServeController {
  status(port: number): Promise<ServeOutcome>;
  on(port: number): Promise<ServeOutcome>;
  off(port: number, managed: boolean): Promise<ServeOutcome>;
}

export function createServeController(deps: ServeDeps = defaultServeDeps()): ServeController {
  return {
    status: (port) => serveStatus(deps, port),
    on: (port) => serveOn(deps, port),
    off: (port, managed) => serveOff(deps, port, managed),
  };
}
