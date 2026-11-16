import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeRemoteHost } from "../core/config.js";

export interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
}

const MAC_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Environment variables are case-insensitive on Windows (`Path`, `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Absolute path of the Tailscale CLI, or null. Never a bare name: on Windows, CreateProcess looks in the current
 * directory first, so a `tailscale.exe` dropped into whatever folder the server was started from would run. We prefer
 * the standard install location, then search PATH entries that are absolute (which skips ".", "" and relative ones).
 */
export function resolveTailscaleExecutable(deps: ResolveDeps = defaultDeps()): string | null {
  const { platform, env, exists } = deps;
  const p = platform === "win32" ? path.win32 : path.posix;
  const fileName = platform === "win32" ? "tailscale.exe" : "tailscale";

  if (platform === "win32") {
    for (const name of ["ProgramFiles", "ProgramW6432"]) {
      const root = envValue(env, name, platform);
      if (!root || !p.isAbsolute(root)) continue;
      const candidate = p.join(root, "Tailscale", "tailscale.exe");
      if (exists(candidate)) return candidate;
    }
  } else if (platform === "darwin" && exists(MAC_APP_BINARY)) {
    return MAC_APP_BINARY;
  }

  const pathValue = envValue(env, "PATH", platform) ?? "";
  for (const raw of pathValue.split(p.delimiter)) {
    // Windows allows quoted entries in PATH.
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, fileName);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function defaultDeps(): ResolveDeps {
  return { platform: process.platform, env: process.env, exists: existsSync };
}

/**
 * This machine's Tailscale DNS name, from the local `tailscale status --json` (a local CLI call: no internet access
 * from us). Null when Tailscale isn't installed, isn't running, or reports no usable name.
 */
export function detectTailscaleHost(resolve = resolveTailscaleExecutable): Promise<string | null> {
  return new Promise((done) => {
    const executable = resolve();
    if (!executable) return done(null);
    // No shell: nothing user-controlled is passed anyway, and this avoids quoting differences on Windows.
    execFile(
      executable,
      ["status", "--json"],
      { timeout: 2000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout) => {
        if (error) return done(null);
        try {
          const parsed: unknown = JSON.parse(stdout);
          const self = (parsed as { Self?: { DNSName?: unknown } } | null)?.Self;
          const dns = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
          done(normalizeRemoteHost(dns));
        } catch {
          done(null);
        }
      },
    );
  });
}
