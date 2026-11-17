import { createHash } from "node:crypto";
import { z } from "zod";
import { AdError } from "../core/errors.js";
import { RateLimiter } from "../core/limits.js";
import type { Scene } from "../core/schemas.js";
import { parseJson, providerRequest, type ProviderHttp } from "./http.js";
import { keywords, type Orientation } from "./pexels.js";
import type { VisualProvider } from "./types.js";

export const PIXABAY_BASE_URL = "https://pixabay.com";

export interface PixabayOptions {
  apiKey: string;
  /** For tests. Not read from any shared environment variable. */
  baseUrl?: string;
  fetch?: typeof fetch;
  orientation?: Orientation;
  /** "video" tries a clip first and falls back to a photo; "photo" never uses clips. */
  media?: "video" | "photo";
  /** Used for scenes whose visual_source is not "stock". */
  fallback: VisualProvider;
  /** Requests per minute we allow ourselves. Pixabay's default is 100 a minute, so the default leaves room. */
  perMinuteBudget?: number;
  /** Hosts media may come from. A result pointing anywhere else is skipped. */
  mediaHosts?: string[];
  timeoutMs?: number;
  now?: () => number;
}

// Shapes are checked, not trusted. Unknown extra fields are ignored; anything we rely on must be present.
const Photo = z.object({ id: z.number(), largeImageURL: z.string().optional(), webformatURL: z.string().optional() });
const PhotoSearch = z.object({ hits: z.array(Photo).default([]) });
const Rendition = z.object({ url: z.string().optional(), width: z.number().optional(), height: z.number().optional() });
const Video = z.object({ id: z.number(), duration: z.number().optional(), videos: z.record(z.string(), Rendition).default({}) });
const VideoSearch = z.object({ hits: z.array(Video).default([]) });

const hashInt = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const DAY = 86_400_000;

/**
 * Stock footage and photos from Pixabay (free API key, content licence that allows commercial use without attribution;
 * read the current terms before you rely on it). Pixabay asks that results be cached for 24 hours and that media is
 * downloaded rather than linked, which is what happens here: only a search result is cached, and the media is
 * downloaded by the media ingestor like any other remote file.
 *
 * Pixabay takes its key as a query parameter, so the key sits in the request address. It is never logged, never
 * placed in an error message, and never part of a cache key.
 */
export class PixabayVisualProvider implements VisualProvider {
  private cfg: ProviderHttp;
  private base: string;
  private limiter: RateLimiter;
  private cache = new Map<string, { at: number; value: unknown }>();
  private hosts: string[];
  private now: () => number;
  requests = 0;

  constructor(private opts: PixabayOptions) {
    if (!opts.apiKey) throw new Error("PixabayVisualProvider needs an apiKey");
    this.now = opts.now ?? Date.now;
    this.base = (opts.baseUrl ?? PIXABAY_BASE_URL).replace(/\/+$/, "");
    this.limiter = new RateLimiter(this.now);
    this.hosts = (opts.mediaHosts ?? ["pixabay.com"]).map((h) => h.toLowerCase());
    this.cfg = { name: "Pixabay", keyVar: "PIXABAY_API_KEY", fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 20_000, maxBytes: 2_000_000, now: this.now };
  }

  async generate(scene: Scene): Promise<{ url: string; provider: string; kind?: "image" | "video" }> {
    if (scene.visual_source !== "stock") return this.opts.fallback.generate(scene);
    const first = keywords(scene.visual_prompt, 6);
    const queries = [...new Set([first, first.split(" ").slice(0, 3).join(" ")].filter(Boolean))];
    if (!queries.length) throw new AdError("invalid_input", `Scene ${scene.id} has no searchable subject in its visual description.`, undefined, { retry: false });
    for (const q of queries) {
      if ((this.opts.media ?? "video") === "video") {
        const clip = this.pickVideo(await this.search("api/videos/", q, VideoSearch), scene);
        if (clip) return { url: clip, provider: "pixabay", kind: "video" };
      }
      const photo = this.pickPhoto(await this.search("api/", q, PhotoSearch), scene);
      if (photo) return { url: photo, provider: "pixabay", kind: "image" };
    }
    throw new AdError("not_found", `Pixabay had nothing for "${queries[0]}". Rewrite the scene's visual description with simpler words.`, undefined, { retry: false });
  }

  private async search<T>(path: string, query: string, schema: z.ZodType<T>): Promise<T> {
    const orientation = this.opts.orientation ?? "portrait";
    const params = new URLSearchParams({ q: query.slice(0, 100), per_page: "20", safesearch: "true" });
    if (path === "api/") {
      params.set("image_type", "photo");
      params.set("orientation", orientation === "portrait" ? "vertical" : orientation === "landscape" ? "horizontal" : "all");
    }
    const cacheKey = `${path}?${params}`; // no key in here
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < DAY) return cached.value as T;
    // Our own guard against the provider's per-minute limit. It is final: it is our budget, not a transient error.
    this.limiter.take("pixabay", "all", this.opts.perMinuteBudget ?? 80, 60_000, { label: "Pixabay searches" });
    params.set("key", this.opts.apiKey);
    this.requests++;
    const reply = await providerRequest(this.cfg, `${this.base}/${path}?${params}`, { method: "GET", headers: { accept: "application/json" } });
    const parsed = schema.safeParse(parseJson(this.cfg, reply));
    if (!parsed.success) throw new AdError("provider_unavailable", "Pixabay returned an answer in an unexpected shape.");
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cacheKey, { at: this.now(), value: parsed.data });
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
    return this.choose(found.hits.map((p) => p.largeImageURL ?? p.webformatURL).filter(this.allowed.bind(this)), scene);
  }

  private pickVideo(found: z.infer<typeof VideoSearch>, scene: Scene): string | undefined {
    const want = this.opts.orientation ?? "portrait";
    const shape = (w: number, h: number): Orientation => (h > w * 1.1 ? "portrait" : w > h * 1.1 ? "landscape" : "square");
    const candidates: { link: string; long: boolean; fits: boolean }[] = [];
    for (const v of found.hits) {
      // Best rendition per clip: up to 1080 on its short side, as large as possible.
      const best = Object.values(v.videos)
        .filter((r) => this.allowed(r.url) && r.width && r.height && Math.min(r.width, r.height) <= 1080 && Math.min(r.width, r.height) >= 480)
        .sort((a, b) => Math.min(b.width!, b.height!) - Math.min(a.width!, a.height!))[0];
      if (best) candidates.push({ link: best.url!, long: (v.duration ?? 0) >= scene.duration_s, fits: shape(best.width!, best.height!) === want });
    }
    // Clips of the wanted shape come first (Pixabay's video search cannot filter by orientation), then clips long enough
    // for the scene. A clip of another shape is still usable: the renderer crops it to fill.
    const rank = (c: { long: boolean; fits: boolean }) => (c.fits ? 0 : 2) + (c.long ? 0 : 1);
    candidates.sort((a, b) => rank(a) - rank(b));
    const top = candidates.filter((c) => rank(c) === rank(candidates[0]));
    return this.choose(top.map((c) => c.link), scene);
  }
}
