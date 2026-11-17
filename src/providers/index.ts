import { ClaudeClient } from "./claude/client.js";
import { ClaudeScriptProvider } from "./claude/script.js";
import { ClaudeSemanticChecker } from "./claude/semantic.js";
import { ClaudeVariantProvider } from "./claude/variants.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DownloadSigner } from "../core/downloads.js";
import { FetchQuota, parseLimits } from "../core/limits.js";
import { RemotionRenderer } from "../render/remotion.js";
import type { ServiceOptions } from "../core/service.js";
import { MediaIngestor } from "../net/ingest.js";
import { SafeFetcher } from "../net/safe-fetch.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import { PexelsVisualProvider, type Orientation } from "./pexels.js";
import { createStubProviders } from "./stub.js";
import type { Providers } from "./types.js";

export interface ProviderSetup {
  providers: Providers;
  /** Human-readable summary for startup logs. Never contains the key. */
  summary: string;
  claude?: ClaudeClient;
  /** Set when a renderer that writes files is in use. Pass it to the service. */
  renderDir?: string;
  /** The one folder the renderer reads media from. Logos and downloaded scene media are stored here. */
  assetDir?: string;
}

/**
 * Real Claude providers for script, variants and semantic checks when ANTHROPIC_API_KEY is set; stubs otherwise.
 * Visuals, voice and rendering stay stubs until M5. The base URL comes from HOOKMINT_ANTHROPIC_BASE_URL only,
 * never from ANTHROPIC_BASE_URL, which other tools set for their own gateways.
 */
export function createProviders(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ProviderSetup {
  const stub = createStubProviders();
  const dataDir = path.resolve(env.HOOKMINT_DATA_DIR?.trim() || "data");
  let renderer = "";
  let renderDir: string | undefined;
  let assetDir: string | undefined;
  if (env.HOOKMINT_RENDERER?.trim() === "remotion") {
    const assetRoot = path.join(dataDir, "assets");
    assetDir = assetRoot;
    renderDir = path.join(dataDir, "renders");
    mkdirSync(assetRoot, { recursive: true });
    mkdirSync(renderDir, { recursive: true });
    stub.renderer = new RemotionRenderer({ assetRoot, concurrency: Number(env.HOOKMINT_RENDER_CONCURRENCY) || 1 });
    renderer = `; real MP4 rendering with Remotion into ${renderDir}`;
  }
  // Stock footage and voice. Base URLs come from HOOKMINT_* variables only, never from a shared OPENAI_BASE_URL.
  const media: string[] = [];
  const pexelsKey = env.PEXELS_API_KEY?.trim();
  if (pexelsKey) {
    const o = env.HOOKMINT_PEXELS_ORIENTATION?.trim();
    stub.visual = new PexelsVisualProvider({
      apiKey: pexelsKey,
      baseUrl: env.HOOKMINT_PEXELS_BASE_URL?.trim() || undefined,
      fetch: fetchImpl,
      orientation: o === "landscape" || o === "square" ? (o as Orientation) : "portrait",
      media: env.HOOKMINT_PEXELS_MEDIA?.trim() === "photo" ? "photo" : "video",
      fallback: stub.visual,
    });
    media.push(assetDir ? "Pexels stock footage for stock scenes" : "Pexels stock footage (no real renderer, so it is not downloaded)");
  }
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey && assetDir) {
    stub.voice = new OpenAIVoiceProvider({
      apiKey: openaiKey,
      baseUrl: env.HOOKMINT_OPENAI_BASE_URL?.trim() || undefined,
      fetch: fetchImpl,
      model: env.HOOKMINT_TTS_MODEL?.trim() || undefined,
      voice: env.HOOKMINT_TTS_VOICE?.trim() || undefined,
    });
    media.push("OpenAI text-to-speech voiceover (AI-generated voice)");
  } else if (openaiKey) {
    media.push("OPENAI_API_KEY is set but voiceover needs HOOKMINT_RENDERER=remotion to store the audio, so the voice stays a stub");
  }
  const mediaNote = media.length ? `; ${media.join("; ")}` : "";

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { providers: stub, renderDir, assetDir, summary: `stub providers (set ANTHROPIC_API_KEY to use Claude for script, variants and semantic checks)${mediaNote}${renderer}` };

  const model = env.HOOKMINT_MODEL?.trim() || "claude-sonnet-5-5";
  const semanticModel = env.HOOKMINT_SEMANTIC_MODEL?.trim() || "claude-haiku-5-5";
  const claude = new ClaudeClient({ apiKey, baseUrl: env.HOOKMINT_ANTHROPIC_BASE_URL?.trim() || undefined, fetch: fetchImpl });
  return {
    providers: {
      ...stub,
      script: new ClaudeScriptProvider(claude, model),
      variants: new ClaudeVariantProvider(claude, model),
      semantic: new ClaudeSemanticChecker(claude, semanticModel),
    },
    summary: `Claude for script and variants (${model}) and semantic checks (${semanticModel})${mediaNote || "; stubs for visuals and voice"}${renderer || "; stub rendering"}`,
    claude,
    renderDir,
    assetDir,
  };
}

/** Service settings from the environment: where videos go and how download links are signed. */
export function serviceOptions(setup: ProviderSetup, env: Record<string, string | undefined> = process.env, opts: { port?: number; exposeLocalPaths?: boolean } = {}): Partial<ServiceOptions> {
  const ttl = Math.min(3600, Math.max(60, Number(env.HOOKMINT_DOWNLOAD_TTL_S) || 900));
  const secret = env.HOOKMINT_URL_SECRET?.trim() || undefined;
  const limits = parseLimits(env.HOOKMINT_LIMITS);
  return {
    limits,
    renderDir: setup.renderDir,
    ingestor: setup.assetDir ? new MediaIngestor(new SafeFetcher(), setup.assetDir, undefined, new FetchQuota(limits)) : undefined,
    exposeLocalPaths: opts.exposeLocalPaths ?? false,
    downloads: new DownloadSigner({ secret, baseUrl: env.HOOKMINT_PUBLIC_URL?.trim() || `http://localhost:${opts.port ?? 3000}`, ttlSeconds: ttl }),
  };
}
