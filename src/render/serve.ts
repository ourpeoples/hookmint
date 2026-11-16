import { createReadStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Serves one file with Range support (video players seek with it). Returns after the response is started. */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: { path: string; type: string; headers?: Record<string, string> },
): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(file.path)).size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers: Record<string, string | number> = { "content-type": file.type, "accept-ranges": "bytes", ...file.headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const head = req.method === "HEAD";
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    if (head) res.end();
    else createReadStream(file.path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  if (head) res.end();
  else createReadStream(file.path).pipe(res);
}
