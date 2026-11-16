import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

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
# UTF-8 without a BOM, so command lines with non-ASCII characters survive the pipe.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# Control and line-separator characters could split or break the one-line answer; they carry no meaning here.
function Clean([string]$text) { return [regex]::Replace($text, '[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]', ' ') }
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $ids = @($line -split ',' | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ })
    $items = @()
    if ($ids.Count -gt 0) {
      $filter = ($ids | ForEach-Object { "ParentProcessId=$_" }) -join ' OR '
      $items = @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -OperationTimeoutSec 10 | Where-Object { $_.CreationDate } | ForEach-Object {
        [pscustomobject]@{
          pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = Clean ([string]$_.Name); cmd = Clean ([string]$_.CommandLine)
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
/** PowerShell itself can take a long while to start on a busy machine; that is not a slow request. */
const WORKER_START_TIMEOUT_MS = 60_000;

/** Lists children through a long-lived PowerShell worker, started on first use and restarted if it dies. */
export function createWindowsLister(): ListChildren & { dispose: () => void } {
  interface Worker {
    child: ChildProcessWithoutNullStreams;
    ready: Promise<void>;
  }
  let worker: Worker | undefined;
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let queue = Promise.resolve();

  function startWorker(): Worker {
    const encoded = Buffer.from(WINDOWS_WORKER_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.resume(); // Never let an unread stderr pipe fill up and stall the worker.
    let onReady: () => void = () => {};
    let onNotReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onNotReady = reject;
    });
    ready.catch(() => {}); // Reported to whoever asks; never an unhandled rejection.
    const startTimer = setTimeout(() => {
      onNotReady(new Error(`process lister did not start within ${WORKER_START_TIMEOUT_MS / 1000}s`));
      child.kill();
    }, WORKER_START_TIMEOUT_MS);
    // Split on \n only. readline also splits on U+2028/U+2029, which a command line may contain.
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered
          .slice(0, end)
          .replace(/^\uFEFF/, "")
          .replace(/\r$/, "");
        buffered = buffered.slice(end + 1);
        if (line === "ready") {
          clearTimeout(startTimer);
          onReady();
          continue;
        }
        const request = pending;
        pending = undefined;
        request?.resolve(line);
      }
    });
    const fail = (error: Error) => {
      clearTimeout(startTimer);
      onNotReady(error);
      if (worker?.child === child) worker = undefined;
      pending?.reject(error);
      pending = undefined;
    };
    child.on("exit", (code) => fail(new Error(`process lister exited (code ${code})`)));
    child.on("error", fail);
    return { child, ready };
  }

  async function ask(line: string): Promise<string> {
    worker ??= startWorker();
    const current = worker;
    await current.ready;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        current.child.kill(); // A stuck worker is replaced on the next request.
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
      current.child.stdin.write(`${line}\n`);
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
      const parsed = parseJsonLine(line);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        throw new Error(`process lister: ${String((parsed as { error: unknown }).error)}`);
      }
      return parseWindowsList(line);
    });
  };

  return Object.assign(list, {
    dispose: () => {
      worker?.child.kill();
      worker = undefined;
    },
  });
}

/** JSON.parse that tolerates raw control characters (invalid inside strings) by blanking them: only names matter. */
function parseJsonLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: blanking control characters is the point
    return JSON.parse(text.replace(/[\u0000-\u001f]/g, " "));
  }
}

export function parseWindowsList(stdout: string): ChildProcessInfo[] {
  const text = stdout.trim();
  if (text === "") return [];
  const parsed: unknown = parseJsonLine(text);
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
