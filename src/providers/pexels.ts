import { createHash } from "node:crypto";
import { z } from "zod";
import { AdError } from "../core/errors.js";
import { RateLimiter } from "../core/limits.js";
import type { Scene } from "../core/schemas.js";
import { parseJson, providerRequest, type ProviderHttp } from "./http.js";
import type { VisualProvider } from "./types.js";

export const PEXELS_BASE_URL = "https://api.pexels.com";
export type Orientation = "portrait" | "landscape" | "square";

export interface PexelsOptions {
  apiKey: string;
  /** For tests. Not read from any shared environment variable. */
  baseUrl?: string;
  fetch?: typeof fetch;
  orientation?: Orientation;
  /** "video" tries a clip first and falls back to a photo; "photo" never uses clips. */
  media?: "video" | "photo";
  /** Used for scenes whose visual_source is not "stock" (generated or uploaded media Pexels cannot supply). */
  fallback: VisualProvider;
  /** Requests per hour we allow ourselves. Pexels' free plan allows 200, so the default leaves room. */
  hourlyBudget?: number;
  /** Hosts media may come from. A result pointing anywhere else is skipped. */
  mediaHosts?: string[];
  timeoutMs?: number;
  now?: () => number;
}

// Shapes are checked, not trusted. Unknown extra fields are ignored; anything we rely on must be present.
const Photo = z.object({ id: z.number(), src: z.object({ large2x: z.string().optional(), large: z.string().optional() }) });
const PhotoSearch = z.object({ photos: z.array(Photo).default([]) });
const VideoFile = z.object({ file_type: z.string().optional(), width: z.number().nullable().optional(), height: z.number().nullable().optional(), link: z.string() });
const Video = z.object({ id: z.number(), duration: z.number().optional(), video_files: z.array(VideoFile).default([]) });
const VideoSearch = z.object({ videos: z.array(Video).default([]) });

const STOP = new Set("a an the and or of in on at to for with from by is are be this that these those it its into over under while as then than very your you our we they their his her him she he who whom which what when where".split(" "));

/** Search engines want a few plain nouns, not a creative brief: "A happy family relaxing in a bright, clean living room" becomes "happy family relaxing bright clean living". */
export function keywords(prompt: string, max = 6): string {
  const words = prompt
    .toLowerCase()
    .split("|")[0] // variants append "| style: ..." to the prompt; that is not subject matter
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, max).join(" ");
}

const hashInt = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);

/**
 * Stock footage and photos from Pexels (free API, commercial use, no attribution required; check the current terms
 * and the rules about identifiable people before you rely on it). Only "stock" scenes come here; the rest go to the fallback.
 *
 * Choices are deterministic per scene id, so a retry or a redelivery picks the same clip and never pays twice, while
 * different scenes of one ad tend to get different clips. Results are cached for an hour to spare the hourly quota.
 */
export class PexelsVisualProvider implements VisualProvider {
  private cfg: ProviderHttp;
  private base: string;
  private limiter: RateLimiter;
  private cache = new Map<string, { at: number; value: unknown }>();
  private hosts: string[];
  private now: () => number;
  requests = 0;

  constructor(private opts: PexelsOptions) {
    if (!opts.apiKey) throw new Error("PexelsVisualProvider needs an apiKey");
    this.now = opts.now ?? Date.now;
    this.base = (opts.baseUrl ?? PEXELS_BASE_URL).replace(/\/+$/, "");
    this.limiter = new RateLimiter(this.now);
    this.hosts = (opts.mediaHosts ?? ["pexels.com"]).map((h) => h.toLowerCase());
    this.cfg = { name: "Pexels", keyVar: "PEXELS_API_KEY", fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 20_000, maxBytes: 2_000_000, now: this.now };
  }

  async generate(scene: Scene): Promise<{ url: string; provider: string; kind?: "image" | "video" }> {
    if (scene.visual_source !== "stock") return this.opts.fallback.generate(scene);
    const first = keywords(scene.visual_prompt, 6);
    const queries = [...new Set([first, first.split(" ").slice(0, 3).join(" ")].filter(Boolean))];
    if (!queries.length) throw new AdError("invalid_input", `Scene ${scene.id} has no searchable subject in its visual description.`, undefined, { retry: false });
    const orientation = this.opts.orientation ?? "portrait";
    for (const q of queries) {
      if ((this.opts.media ?? "video") === "video") {
        const clip = this.pickVideo(await this.search("videos", q, orientation, VideoSearch), scene);
        if (clip) return { url: clip, provider: "pexels", kind: "video" };
      }
      const photo = this.pickPhoto(await this.search("v1", q, orientation, PhotoSearch), scene);
      if (photo) return { url: photo, provider: "pexels", kind: "image" };
    }
    throw new AdError("not_found", `Pexels had nothing for "${queries[0]}". Rewrite the scene's visual description with simpler words.`, undefined, { retry: false });
  }

  private async search<T>(kind: "videos" | "v1", query: string, orientation: Orientation, schema: z.ZodType<T>): Promise<T> {
    const path = kind === "videos" ? "videos/search" : "v1/search";
    const url = `${this.base}/${path}?${new URLSearchParams({ query, orientation, per_page: "15", ...(kind === "videos" ? { size: "medium" } : {}) })}`;
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.at < 3_600_000) return cached.value as T;
    // Our own guard against the provider's hourly quota. It is final: waiting an hour is not a retry.
    this.limiter.take("pexels", "all", this.opts.hourlyBudget ?? 180, 3_600_000, { label: "Pexels searches" });
    this.requests++;
    const reply = await providerRequest(this.cfg, url, { method: "GET", headers: { authorization: this.opts.apiKey, accept: "application/json" } });
    const parsed = schema.safeParse(parseJson(this.cfg, reply));
    if (!parsed.success) throw new AdError("provider_unavailable", "Pexels returned an answer in an unexpected shape.");
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, { at: this.now(), value: parsed.data });
    return parsed.data;
  }

  private allowed(link: string | undefined): link is string {
    if (!link) return false;
    try {
      const u = new URL(link);
      return u.protocol === "https:" && this.hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  private choose<T>(items: T[], scene: Scene): T | undefined {
    return items.length ? items[hashInt(scene.id) % Math.min(items.length, 5)] : undefined;
  }

  private pickPhoto(found: z.infer<typeof PhotoSearch>, scene: Scene): string | undefined {
    const urls = found.photos.map((p) => p.src.large2x ?? p.src.large).filter(this.allowed.bind(this));
    return this.choose(urls, scene);
  }

  private pickVideo(found: z.infer<typeof VideoSearch>, scene: Scene): string | undefined {
    const candidates: { link: string; long: boolean }[] = [];
    for (const v of found.videos) {
      // Best file per clip: an mp4 up to 1080 on its short side, as large as possible. 4K files are large and gain nothing in a 1080p ad.
      const files = v.video_files
        .filter((f) => f.file_type === "video/mp4" && this.allowed(f.link) && f.width && f.height && Math.min(f.width, f.height) <= 1080 && Math.min(f.width, f.height) >= 480)
        .sort((a, b) => Math.min(b.width!, b.height!) - Math.min(a.width!, a.height!));
      if (files[0]) candidates.push({ link: files[0].link, long: (v.duration ?? 0) >= scene.duration_s });
    }
    // A clip shorter than the scene would freeze or loop, so clips long enough come first.
    const ordered = [...candidates.filter((c) => c.long), ...candidates.filter((c) => !c.long)].map((c) => c.link);
    return this.choose(ordered, scene);
  }
}
