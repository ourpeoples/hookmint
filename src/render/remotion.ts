import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AspectRatio, BrandKit } from "../core/schemas.js";
import type { RenderArgs, RenderResult, Renderer } from "../providers/types.js";
import { AssetServer, resolveLocalAsset } from "./assets.js";
import { buildTimeline, darken, FPS, type PlanLite, readabilityNotes, sanitizeColor } from "./layout.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = { id: "default", version: "1.0.0" } as const;
const REMOTION_VERSION = "4.0.539";
export const RENDERER_VERSION = `remotion@${REMOTION_VERSION} template ${TEMPLATE.id}@${TEMPLATE.version}`;
const DEFAULT_PRIMARY = "#0a84ff";

const BROWSER_CANDIDATES = ["/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

/** HOOKMINT_BROWSER wins; otherwise the first Chrome or Chromium found in the usual places; otherwise null. */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  const wanted = env.HOOKMINT_BROWSER?.trim();
  if (wanted) return existsSync(wanted) ? wanted : null;
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export interface RemotionRendererOptions {
  /** The only folder the renderer will read media from. */
  assetRoot: string;
  browserExecutable?: string;
  /** How many renders may run at once. Each one drives a browser, so keep it small. */
  concurrency?: number;
  /** Where the Remotion project lives (the folder containing index.tsx and public/). */
  projectDir?: string;
}

type Remotion = { bundler: typeof import("@remotion/bundler"); renderer: typeof import("@remotion/renderer") };

/**
 * Renders a plan to an MP4 with the Remotion template in /render. Branding, text, captions and the call to
 * action are drawn by code, so they are always sharp and always inside the safe area. Visuals and voiceover are
 * used when they are local files under `assetRoot`; otherwise the scene gets a brand gradient and the notes say so.
 */
export class RemotionRenderer implements Renderer {
  private lib: Promise<Remotion> | null = null;
  private serveUrl: Promise<string> | null = null;
  private running = 0;
  private waiting: (() => void)[] = [];
  private browser: string;
  private projectDir: string;

  constructor(private opts: RemotionRendererOptions) {
    const found = opts.browserExecutable ?? findBrowser();
    if (!found) throw new Error("No Chrome or Chromium found. Install one, or set HOOKMINT_BROWSER to its path.");
    this.browser = found;
    this.projectDir = opts.projectDir ?? path.resolve(here, "../../render");
  }

  private async load(): Promise<Remotion> {
    this.lib ??= (async () => ({ bundler: await import("@remotion/bundler"), renderer: await import("@remotion/renderer") }))();
    return this.lib;
  }

  /** The bundle is built once and reused. Building it takes several seconds. */
  private async bundleUrl(): Promise<string> {
    this.serveUrl ??= (async () => {
      const { bundler } = await this.load();
      return bundler.bundle({ entryPoint: path.join(this.projectDir, "index.tsx"), publicDir: path.join(this.projectDir, "public") });
    })();
    try {
      return await this.serveUrl;
    } catch (err) {
      this.serveUrl = null; // let the next render try again
      throw err;
    }
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.opts.concurrency ?? 1;
    if (this.running >= max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Builds the template's inputs and the notes. Shared by render() and the test-only still helper. */
  async prepare(args: Pick<RenderArgs, "plan" | "aspect" | "assets" | "brand">, server: AssetServer) {
    const plan: PlanLite = {
      hook: args.plan.hook,
      cta: { text: args.plan.cta.text },
      scenes: args.plan.scenes.map((s) => ({ id: s.id, duration_s: s.duration_s, voiceover: s.voiceover, on_screen_text: s.on_screen_text ?? null })),
    };
    const brand = brandProps(args.brand);
    const media: Record<string, { visual?: { kind: "image" | "video"; src: string }; voice?: { src: string } }> = {};
    const noVisual: string[] = [];
    const noVoice: string[] = [];
    const notes: string[] = [];
    for (const s of args.plan.scenes) {
      const a = args.assets[s.id];
      const entry: (typeof media)[string] = {};
      const v = await resolveLocalAsset(a?.visual_url, this.opts.assetRoot, "visual");
      if (v.ok && v.kind !== "audio") entry.visual = { kind: v.kind, src: server.register(v.path) };
      else noVisual.push(s.id);
      const a2 = await resolveLocalAsset(a?.voice_url, this.opts.assetRoot, "voice");
      if (a2.ok) entry.voice = { src: server.register(a2.path) };
      else noVoice.push(s.id);
      media[s.id] = entry;
    }
    if (noVisual.length) notes.push(`No usable visual for scene${noVisual.length > 1 ? "s" : ""} ${noVisual.join(", ")}; the brand gradient was used instead.`);
    if (noVoice.length === args.plan.scenes.length) notes.push("No voiceover audio is available yet, so this video has no sound.");
    else if (noVoice.length) notes.push(`No voiceover audio for scene${noVoice.length > 1 ? "s" : ""} ${noVoice.join(", ")}; those parts are silent.`);
    if (args.plan.template.id !== TEMPLATE.id || args.plan.template.version !== TEMPLATE.version) {
      notes.push(`The plan names template ${args.plan.template.id}@${args.plan.template.version}, but this renderer only has ${TEMPLATE.id}@${TEMPLATE.version}, so that one was used.`);
    }
    notes.push(...readabilityNotes(plan, args.aspect));
    return { inputProps: { plan, aspect: args.aspect, brand, media } as Record<string, unknown>, notes, totalFrames: buildTimeline(plan).totalFrames };
  }

  async render(args: RenderArgs): Promise<RenderResult> {
    if (!args.outputPath) throw new Error("RemotionRenderer needs an outputPath");
    const outputPath = args.outputPath;
    return this.slot(async () => {
      const { renderer } = await this.load();
      const serveUrl = await this.bundleUrl();
      const server = new AssetServer();
      await server.start();
      try {
        const { inputProps, notes, totalFrames } = await this.prepare(args, server);
        const common = { serveUrl, browserExecutable: this.browser, logLevel: "error" as const };
        const composition = await renderer.selectComposition({ ...common, id: compositionId(args.aspect), inputProps });
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await renderer.renderMedia({ ...common, composition, inputProps, codec: "h264", outputLocation: outputPath, metadata: withRendererFacts(args.metadata), overwrite: true });
        const { size } = await fs.stat(outputPath);
        return { file: { bytes: size, duration_s: totalFrames / FPS }, notes, renderer_version: RENDERER_VERSION };
      } finally {
        await server.close();
      }
    });
  }

  /** One PNG frame of the layout probe (black background, solid white boxes). Used by tests to prove safe zones. */
  async probeStill(args: Pick<RenderArgs, "plan" | "aspect" | "brand">, frame: number, outputPath: string): Promise<void> {
    await this.slot(async () => {
      const { renderer } = await this.load();
      const serveUrl = await this.bundleUrl();
      const server = new AssetServer();
      await server.start();
      try {
        const { inputProps } = await this.prepare({ ...args, assets: {} }, server);
        const props = { ...inputProps, probe: true };
        const common = { serveUrl, browserExecutable: this.browser, logLevel: "error" as const };
        const composition = await renderer.selectComposition({ ...common, id: compositionId(args.aspect), inputProps: props });
        await renderer.renderStill({ ...common, composition, inputProps: props, frame, output: outputPath, imageFormat: "png", overwrite: true });
      } finally {
        await server.close();
      }
    });
  }

  /** A normal (not probe) PNG frame, for checking that real media shows up. */
  async still(args: Pick<RenderArgs, "plan" | "aspect" | "brand" | "assets">, frame: number, outputPath: string): Promise<void> {
    await this.slot(async () => {
      const { renderer } = await this.load();
      const serveUrl = await this.bundleUrl();
      const server = new AssetServer();
      await server.start();
      try {
        const { inputProps } = await this.prepare(args, server);
        const common = { serveUrl, browserExecutable: this.browser, logLevel: "error" as const };
        const composition = await renderer.selectComposition({ ...common, id: compositionId(args.aspect), inputProps });
        await renderer.renderStill({ ...common, composition, inputProps, frame, output: outputPath, imageFormat: "png", overwrite: true });
      } finally {
        await server.close();
      }
    });
  }
}

/**
 * The provenance block says which template and renderer actually made the file, whatever the plan asked for.
 * Metadata that is not a JSON object in `description` is passed through unchanged.
 */
export function withRendererFacts(metadata?: Record<string, string>): Record<string, string> | null {
  if (!metadata) return null;
  try {
    const d = JSON.parse(metadata.description ?? "");
    if (d && typeof d === "object" && !Array.isArray(d)) return { ...metadata, description: JSON.stringify({ ...d, template: TEMPLATE, rendered_with: RENDERER_VERSION }) };
  } catch {
    /* not JSON: leave as is */
  }
  return metadata;
}

export const compositionId = (aspect: AspectRatio) => `Ad-${aspect.replace(":", "x")}`;

/** Brand values that reach CSS: a plain-hex colour only, and a short name. */
export function brandProps(brand?: BrandKit) {
  const primary = sanitizeColor(brand?.colors?.[0], DEFAULT_PRIMARY);
  return { name: (brand?.name ?? "").slice(0, 40), primary, secondary: darken(primary) };
}
