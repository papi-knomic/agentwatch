import { execFile } from "node:child_process";

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

// Pids travel in an env var and are re-parsed as integers, never spliced into the script.
const WINDOWS_SCRIPT = `
$ids = $env:AGENT_WATCH_PIDS -split ',' | ForEach-Object { [int]$_ }
$filter = ($ids | ForEach-Object { "ParentProcessId=$_" }) -join ' OR '
$items = @(Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine
    created = $_.CreationDate.ToUniversalTime().ToString('o')
  }
})
ConvertTo-Json -InputObject $items -Compress
`;

export async function listChildrenWindows(parentPids: number[]): Promise<ChildProcessInfo[]> {
  if (parentPids.length === 0) return [];
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const stdout = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { AGENT_WATCH_PIDS: parentPids.join(",") },
  );
  return parseWindowsList(stdout);
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
  return platform === "win32" ? listChildrenWindows : listChildrenPosix;
}
