import type { SemanticChecker } from "../brand/semantic.js";
import type { AspectRatio, BrandKit, Scene, ScenePlan } from "../core/schemas.js";

export interface ScriptInput {
  prompt: string;
  duration_s: number;
  aspect_ratios: AspectRatio[];
  brand?: BrandKit;
  /** The brand's rules and examples, so generation avoids what checks would flag. Checks still enforce them. */
  guidance?: {
    rules: { type: string; pattern: string }[];
    examples: { kind: string; text: string }[];
  };
}

export interface ScriptProvider {
  generate(input: ScriptInput): Promise<ScenePlan>;
}

export interface VisualProvider {
  /** `kind` says whether the url is a still or a clip. When absent, "video_gen" scenes are treated as clips and the rest as stills. */
  generate(scene: Scene): Promise<{ url: string; provider: string; kind?: "image" | "video" }>;
}

export interface VoiceProvider {
  generate(scene: Scene): Promise<{ url: string; provider: string }>;
}

export interface RenderArgs {
  plan: ScenePlan;
  aspect: AspectRatio;
  assets: Record<string, { visual_url: string; voice_url: string }>;
  brand?: BrandKit;
  /** Server path of the brand's cleaned logo, when it has one. */
  logoPath?: string;
  /** Where to write the finished file. Renderers that produce no file (the stub) ignore it. */
  outputPath?: string;
  /** Container metadata to embed (provenance). */
  metadata?: Record<string, string>;
}

export interface RenderResult {
  /** A remote URL, for renderers that host their own output (the stub). */
  url?: string;
  /** A file written at `outputPath`. The service serves it through short-lived signed links. */
  file?: { bytes: number; duration_s: number };
  /** Plain-language notes about the render (missing media, text that will not fit). Advisory. */
  notes?: string[];
  /** What produced it, for provenance, e.g. "remotion@4.0.539 template default@1.0.0". */
  renderer_version?: string;
}

export interface Renderer {
  render(args: RenderArgs): Promise<RenderResult>;
}

export interface Providers {
  script: ScriptProvider;
  visual: VisualProvider;
  voice: VoiceProvider;
  renderer: Renderer;
  variants: VariantProvider;
  /** Optional. Without it, semantic brand rules stay inactive and check_ad says so. */
  semantic?: SemanticChecker;
}

export interface VariantInput {
  basePlan: ScenePlan;
  tested_variable: "hook" | "angle" | "offer" | "cta" | "visual_style";
  count: number;
  brand?: BrandKit;
  /** Plans already in the variant group, so the provider can avoid repeating them. */
  existing: ScenePlan[];
}

/** Returns untrusted plans. The service validates every one with the diff engine before using it. */
export interface VariantProvider {
  generate(input: VariantInput): Promise<unknown[]>;
}
