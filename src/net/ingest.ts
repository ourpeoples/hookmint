import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AdError } from "../core/errors.js";
import { type CleanImage, LOGO_LIMITS, PHOTO_LIMITS, sanitizeImage } from "./images.js";
import type { FetchQuotaLike } from "../core/limits.js";
import type { Fetched, FetchLimits, SafeFetcher } from "./safe-fetch.js";

const run = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Demuxer is chosen from the claimed type and forced, so ffprobe never guesses a more exotic format from the content. */
const VIDEO_TYPES: Record<string, { demuxer: string; ext: string }> = {
  "video/mp4": { demuxer: "mov", ext: ".mp4" },
  "video/webm": { demuxer: "matroska", ext: ".webm" },
};
const AUDIO_TYPES: Record<string, { demuxer: string; ext: string }> = {
  "audio/mpeg": { demuxer: "mp3", ext: ".mp3" },
  "audio/wav": { demuxer: "wav", ext: ".wav" },
  "audio/x-wav": { demuxer: "wav", ext: ".wav" },
  "audio/mp4": { demuxer: "mov", ext: ".m4a" },
};
const VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const AUDIO_CODECS = new Set(["mp3", "aac", "pcm_s16le", "pcm_s24le", "vorbis", "opus"]);

export interface IngestLimits {
  logoBytes: number;
  imageBytes: number;
  videoBytes: number;
  audioBytes: number;
  maxVideoSeconds: number;
  maxAudioSeconds: number;
  maxVideoSide: number;
}
export const DEFAULT_INGEST: IngestLimits = {
  logoBytes: 5 * 1024 * 1024,
  imageBytes: 25 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  maxVideoSeconds: 120,
  maxAudioSeconds: 180,
  maxVideoSide: 4096,
};

interface Probe {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  format?: { duration?: string; nb_streams?: number };
}

/**
 * Brings remote media into the one local folder the renderer reads from. Every file is fetched with the
 * hardened fetcher, checked for what it really is, and stored under a name the server chose (never one taken
 * from the URL), so nothing a user or a provider sends can decide where a file lands.
 */
export class MediaIngestor {
  constructor(
    private fetcher: Pick<SafeFetcher, "get" | "checkUrl">,
    readonly root: string,
    private limits: IngestLimits = DEFAULT_INGEST,
    /** Daily download allowance per account. Without it, downloads are unlimited (tests only). */
    private quota?: FetchQuotaLike,
  ) {}

  /** True when downloads are already limited, so the service does not add its own allowance on top. */
  hasQuota(): boolean {
    return this.quota !== undefined;
  }
  /** Sets the download allowance. The service uses this to share the allowance across instances. */
  useQuota(quota: FetchQuotaLike): void {
    this.quota = quota;
  }

  /** Refuses a bad address immediately, with no network. */
  checkUrl(url: string): void {
    this.fetcher.checkUrl(url);
  }

  private id(v: string, what: string): string {
    if (!SAFE_ID.test(v)) throw new AdError("invalid_input", `Unsafe ${what}.`);
    return v;
  }

  private async store(dir: string, name: string, bytes: Buffer): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const final = path.join(dir, name);
    const tmp = path.join(dir, `.incoming-${randomBytes(8).toString("hex")}`);
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, final);
    return final;
  }

  private async fetch(accountId: string, url: string, maxBytes: number, accept: string[]): Promise<Fetched> {
    const limits: FetchLimits = { maxBytes, accept };
    await this.quota?.before(this.id(accountId, "account id"));
    const got = await this.fetcher.get(url, limits);
    await this.quota?.after(accountId, got.bytes.length);
    return got;
  }

  /** A brand logo, as a PNG no larger than 1024 pixels on its longest side. Returns the file path. */
  async logo(accountId: string, kitId: string, url: string): Promise<{ path: string; image: CleanImage }> {
    const dir = path.join(this.root, "logos", this.id(accountId, "account id"));
    const got = await this.fetch(accountId, url, this.limits.logoBytes, IMAGE_TYPES);
    const image = await sanitizeImage(got.bytes, "logo", LOGO_LIMITS);
    return { path: await this.store(dir, `${this.id(kitId, "brand kit id")}.png`, image.bytes), image };
  }

  /** A still image for a scene. Returns the file path. */
  async image(accountId: string, url: string): Promise<string> {
    const got = await this.fetch(accountId, url, this.limits.imageBytes, IMAGE_TYPES);
    const image = await sanitizeImage(got.bytes, "photo", PHOTO_LIMITS);
    const name = `${createHash("sha256").update(image.bytes).digest("hex").slice(0, 24)}.${image.format === "png" ? "png" : "jpg"}`;
    return this.store(path.join(this.root, "fetched", this.id(accountId, "account id")), name, image.bytes);
  }

  /** A video clip for a scene. Checked with ffprobe: right container, a real video stream, an allowed codec, sane size and length. */
  async video(accountId: string, url: string): Promise<string> {
    const got = await this.fetch(accountId, url, this.limits.videoBytes, Object.keys(VIDEO_TYPES));
    const kind = VIDEO_TYPES[got.contentType];
    return this.validated(accountId, got.bytes, kind, async (p) => {
      const v = p.streams?.find((s) => s.codec_type === "video");
      if (!v || !v.codec_name || !VIDEO_CODECS.has(v.codec_name)) throw new AdError("invalid_input", "That video is not in a supported format (H.264, VP8, VP9 or AV1).");
      if (!v.width || !v.height || v.width > this.limits.maxVideoSide || v.height > this.limits.maxVideoSide) throw new AdError("invalid_input", "That video is too large in pixels.");
      const secs = Number(p.format?.duration);
      if (!Number.isFinite(secs) || secs <= 0 || secs > this.limits.maxVideoSeconds) throw new AdError("invalid_input", `That video must be between a moment and ${this.limits.maxVideoSeconds} seconds long.`);
      if ((p.format?.nb_streams ?? 0) > 8) throw new AdError("invalid_input", "That video has too many tracks.");
    });
  }

  /** A voiceover track. Returns the file path. */
  async audio(accountId: string, url: string): Promise<string> {
    const got = await this.fetch(accountId, url, this.limits.audioBytes, Object.keys(AUDIO_TYPES));
    return this.checkedAudio(accountId, got.bytes, AUDIO_TYPES[got.contentType]);
  }

  /** Audio a provider returned directly (no address to download). It gets the same checks as downloaded audio. */
  async audioBytes(accountId: string, bytes: Buffer, format: "mp3"): Promise<string> {
    if (bytes.length > this.limits.audioBytes) throw new AdError("invalid_input", "That audio file is too large.");
    return this.checkedAudio(accountId, bytes, AUDIO_TYPES[{ mp3: "audio/mpeg" }[format]]);
  }

  private async checkedAudio(accountId: string, bytes: Buffer, kind: { demuxer: string; ext: string }): Promise<string> {
    return this.validated(accountId, bytes, kind, async (p) => {
      if (p.streams?.some((s) => s.codec_type === "video")) throw new AdError("invalid_input", "That audio file contains video.");
      const a = p.streams?.find((s) => s.codec_type === "audio");
      if (!a || !a.codec_name || !AUDIO_CODECS.has(a.codec_name)) throw new AdError("invalid_input", "That audio is not in a supported format.");
      const secs = Number(p.format?.duration);
      if (!Number.isFinite(secs) || secs <= 0 || secs > this.limits.maxAudioSeconds) throw new AdError("invalid_input", `That audio must be between a moment and ${this.limits.maxAudioSeconds} seconds long.`);
    });
  }

  private async validated(accountId: string, bytes: Buffer, kind: { demuxer: string; ext: string }, check: (p: Probe) => Promise<void>): Promise<string> {
    const dir = path.join(this.root, "fetched", this.id(accountId, "account id"));
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.probe-${randomBytes(8).toString("hex")}`);
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    try {
      let probe: Probe;
      try {
        const { RenderInternals } = await import("@remotion/renderer");
        const ffprobe = RenderInternals.getExecutablePath({ type: "ffprobe", indent: false, logLevel: "error", binariesDirectory: null });
        // -f forces the demuxer; -protocol_whitelist file means a crafted playlist cannot make ffprobe open any network or other resource.
        const { stdout } = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-f", kind.demuxer, "-show_streams", "-show_format", "-of", "json", tmp], { timeout: 15_000, maxBuffer: 1_000_000 });
        probe = JSON.parse(stdout) as Probe;
      } catch {
        throw new AdError("invalid_input", "That file is not a valid media file of the type it claims to be.");
      }
      await check(probe);
      const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}${kind.ext}`;
      const final = path.join(dir, name);
      await fs.rename(tmp, final);
      return final;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
}
