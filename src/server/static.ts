import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const NOT_BUILT_HTML = `<!doctype html><meta charset="utf-8"><title>Dashboard not built</title>
<p style="font-family:system-ui;padding:2rem">The dashboard hasn't been built yet. Run <code>npm run build</code>, then reload.</p>`;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Serves the built dashboard. Unknown paths fall back to index.html; nothing outside `root` is reachable. */
export async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const base = resolve(root);
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = resolve(join(base, relative));
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!(await isFile(file))) file = join(base, "index.html");
  if (!(await isFile(file))) {
    res.writeHead(200, { "content-type": CONTENT_TYPES[".html"] }).end(NOT_BUILT_HTML);
    return;
  }
  const body = await readFile(file);
  const cache = file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res
    .writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": cache,
    })
    .end(body);
}
