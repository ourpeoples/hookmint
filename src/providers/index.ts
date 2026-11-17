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
    renderer = `; real MP4 rendering with Remotion into ${renderDir} (visuals and voice are still stubs)`;
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { providers: stub, renderDir, assetDir, summary: `stub providers (set ANTHROPIC_API_KEY to use Claude for script, variants and semantic checks)${renderer}` };

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
    summary: `Claude for script and variants (${model}) and semantic checks (${semanticModel}); stubs for visuals and voice${renderer || "; stub rendering"}`,
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
