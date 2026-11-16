import { spawn } from "node:child_process";

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; detached: true; windowsHide: true },
) => { on: (event: "error", listener: () => void) => unknown; unref: () => void };

/** Opens a URL with the OS handler. Never through a shell: a `claude:` link can contain `&`. */
export function openUrl(
  url: string,
  spawnFn: SpawnFn = spawn,
  platform: NodeJS.Platform = process.platform,
): void {
  const [command, args]: [string, string[]] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawnFn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
