import { createServer, type Server } from "node:http";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveFile } from "./serve.js";

export type MediaKind = "image" | "video" | "audio";

const EXT: Record<string, { kind: MediaKind; type: string }> = {
  ".png": { kind: "image", type: "image/png" },
  ".jpg": { kind: "image", type: "image/jpeg" },
  ".jpeg": { kind: "image", type: "image/jpeg" },
  ".webp": { kind: "image", type: "image/webp" },
  ".mp4": { kind: "video", type: "video/mp4" },
  ".webm": { kind: "video", type: "video/webm" },
  ".mp3": { kind: "audio", type: "audio/mpeg" },
  ".wav": { kind: "audio", type: "audio/wav" },
  ".m4a": { kind: "audio", type: "audio/mp4" },
};
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

export type Resolved = { ok: true; path: string; kind: MediaKind } | { ok: false; reason: string };

/**
 * The renderer only ever reads media that is already on local disk inside `root`. It never fetches a URL, so a
 * hostile or mistaken URL in a plan cannot make the server contact an internal address. Remote media must be
 * downloaded first by a hardened fetcher (not built yet) and placed under `root`.
 */
export async function resolveLocalAsset(url: string | undefined, root: string, want: "visual" | "voice"): Promise<Resolved> {
  if (!url) return { ok: false, reason: "no file" };
  if (!url.startsWith("file://")) return { ok: false, reason: "not a local file (the renderer does not fetch remote media)" };
  let file: string;
  try {
    file = await fs.realpath(fileURLToPath(url));
  } catch {
    return { ok: false, reason: "file not found" };
  }
  const base = await fs.realpath(root).catch(() => null);
  if (!base) return { ok: false, reason: "asset folder is not available" };
  if (file !== base && !file.startsWith(base + path.sep)) return { ok: false, reason: "file is outside the allowed asset folder" };
  const info = EXT[path.extname(file).toLowerCase()];
  if (!info) return { ok: false, reason: "file type is not allowed" };
  if (want === "voice" ? info.kind !== "audio" : info.kind === "audio") return { ok: false, reason: `a ${info.kind} file cannot be used as the ${want}` };
  const st = await fs.stat(file);
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  if (st.size > MAX_ASSET_BYTES) return { ok: false, reason: "file is too large" };
  return { ok: true, path: file, kind: info.kind };
}

/**
 * Serves only files that were explicitly registered, under random names on 127.0.0.1, with range support
 * (video seeking needs it). There is no directory mapping, so there is nothing to traverse.
 */
export class AssetServer {
  private server: Server;
  private files = new Map<string, { path: string; type: string }>();
  private port = 0;

  constructor() {
    this.server = createServer(async (req, res) => {
      const m = /^\/a\/([a-f0-9]{32}\.[a-z0-9]+)$/.exec((req.url ?? "").split("?")[0]);
      const entry = m ? this.files.get(m[1]) : undefined;
      if (!entry || (req.method !== "GET" && req.method !== "HEAD")) return void res.writeHead(404).end();
      await serveFile(req, res, { ...entry, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Returns the URL a browser on this machine can load the file from. */
  register(file: string): string {
    const ext = path.extname(file).toLowerCase();
    const name = `${randomBytes(16).toString("hex")}${ext}`;
    this.files.set(name, { path: file, type: EXT[ext]?.type ?? "application/octet-stream" });
    return `http://127.0.0.1:${this.port}/a/${name}`;
  }

  async close(): Promise<void> {
    this.files.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
