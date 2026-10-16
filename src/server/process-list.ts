import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ChildProcessInfo {
  pid: number;
  parentPid: number;
  /** Epoch ms. */
  startedAt: number;
  name: string;
  command: string;
}

/** Lists the direct children of the given processes. */
export type ListChildren = (parentPids: number[]) => Promise<ChildProcessInfo[]>;

const LIST_TIMEOUT_MS = 5000;

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: LIST_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Windows has no cheap way to list child processes from Node, and starting PowerShell costs seconds on
 * a busy machine. So one PowerShell stays running: it reads a line of comma-separated pids from stdin
 * and answers with one line of JSON. Every value is re-parsed as an integer; nothing is evaluated.
 */
const WINDOWS_WORKER_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $ids = @($line -split ',' | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ })
    $items = @()
    if ($ids.Count -gt 0) {
      $filter = ($ids | ForEach-Object { "ParentProcessId=$_" }) -join ' OR '
      $items = @(Get-CimInstance Win32_Process -Filter $filter | Where-Object { $_.CreationDate } | ForEach-Object {
        [pscustomobject]@{
          pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine
          created = $_.CreationDate.ToUniversalTime().ToString('o')
        }
      })
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $items -Compress -Depth 2))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ error = [string]$_.Exception.Message } -Compress))
  }
}
`;

const WORKER_REQUEST_TIMEOUT_MS = 15_000;

/** Lists children through a long-lived PowerShell worker, started on first use and restarted if it dies. */
export function createWindowsLister(): ListChildren & { dispose: () => void } {
  let worker: ChildProcessWithoutNullStreams | undefined;
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let queue = Promise.resolve();

  function startWorker(): ChildProcessWithoutNullStreams {
    const encoded = Buffer.from(WINDOWS_WORKER_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.resume(); // Never let an unread stderr pipe fill up and stall the worker.
    createInterface({ input: child.stdout }).on("line", (line) => {
      const request = pending;
      pending = undefined;
      request?.resolve(line);
    });
    child.on("exit", (code) => {
      if (worker === child) worker = undefined;
      pending?.reject(new Error(`process lister exited (code ${code})`));
      pending = undefined;
    });
    child.on("error", (error) => {
      if (worker === child) worker = undefined;
      pending?.reject(error);
      pending = undefined;
    });
    return child;
  }

  function ask(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      worker ??= startWorker();
      const child = worker;
      const timer = setTimeout(() => {
        pending = undefined;
        child.kill(); // A stuck worker is replaced on the next request.
        reject(new Error(`process lister timed out after ${WORKER_REQUEST_TIMEOUT_MS / 1000}s`));
      }, WORKER_REQUEST_TIMEOUT_MS);
      pending = {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      child.stdin.write(`${line}\n`);
    });
  }

  const list = (parentPids: number[]): Promise<ChildProcessInfo[]> => {
    if (parentPids.length === 0) return Promise.resolve([]);
    // One request at a time: the worker answers lines in order.
    const result = queue.then(() => ask(parentPids.join(",")));
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then((line) => {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        throw new Error(`process lister: ${String((parsed as { error: unknown }).error)}`);
      }
      return parseWindowsList(line);
    });
  };

  return Object.assign(list, {
    dispose: () => {
      worker?.kill();
      worker = undefined;
    },
  });
}

export function parseWindowsList(stdout: string): ChildProcessInfo[] {
  const text = stdout.trim();
  if (text === "") return [];
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    const { pid, ppid, name, cmd, created } = (item ?? {}) as Record<string, unknown>;
    const startedAt = typeof created === "string" ? Date.parse(created) : Number.NaN;
    if (typeof pid !== "number" || typeof ppid !== "number" || Number.isNaN(startedAt)) return [];
    return [{ pid, parentPid: ppid, startedAt, name: String(name ?? ""), command: String(cmd ?? "") }];
  });
}

/** ps `etime`: [[dd-]hh:]mm:ss → seconds. */
export function parseElapsed(etime: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

export function parsePsList(stdout: string, parentPids: number[], now: number): ChildProcessInfo[] {
  const wanted = new Set(parentPids);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const [, pid, ppid, etime, command = ""] = match;
    const elapsed = parseElapsed(etime ?? "");
    if (!wanted.has(Number(ppid)) || elapsed === undefined) return [];
    const name = command.split(/\s+/)[0]?.split("/").pop() ?? "";
    return [{ pid: Number(pid), parentPid: Number(ppid), startedAt: now - elapsed * 1000, name, command }];
  });
}

export async function listChildrenPosix(parentPids: number[]): Promise<ChildProcessInfo[]> {
  if (parentPids.length === 0) return [];
  // `etime` and `command` work with both procps (Linux) and BSD ps (macOS).
  const stdout = await run("ps", ["-A", "-o", "pid=,ppid=,etime=,command="]);
  return parsePsList(stdout, parentPids, Date.now());
}

export function defaultListChildren(platform: NodeJS.Platform = process.platform): ListChildren {
  return platform === "win32" ? createWindowsLister() : listChildrenPosix;
}
