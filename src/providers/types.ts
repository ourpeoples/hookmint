import type { SemanticChecker } from "../brand/semantic.js";
import type { AspectRatio, BrandKit, Scene, ScenePlan } from "../core/schemas.js";

/**
 * An idea that won a controlled test for this brand: the winning text, what it beat, and by how much. Used as inspiration
 * for new scripts. Never a fact about the product, and never copied word for word.
 */
export interface Learning {
  variable: string;
  metric: string;
  winning: string;
  beaten: string[];
  relative_lift_percent: number;
}

export interface ScriptInput {
  prompt: string;
  duration_s: number;
  aspect_ratios: AspectRatio[];
  brand?: BrandKit;
  /** The brand's rules and examples, so generation avoids what checks would flag. Checks still enforce them. */
  guidance?: {
    rules: { type: string; pattern: string }[];
    examples: { kind: string; text: string }[];
    /** What has won controlled tests for this brand before. Empty when nothing has been concluded. */
    learnings?: Learning[];
  };
}

export interface ScriptProvider {
  generate(input: ScriptInput): Promise<ScenePlan>;
}

export interface VisualProvider {
  /** `kind` says whether the url is a still or a clip. When absent, "video_gen" scenes are treated as clips and the rest as stills. */
  generate(scene: Scene): Promise<{ url: string; provider: string; kind?: "image" | "video" }>;
}

/** A voice is either an address to download from, or the audio itself (for providers that answer with the file). */
export type VoiceResult =
  | { url: string; provider: string; ai_generated?: boolean }
  | { audio: Buffer; format: "mp3"; provider: string; ai_generated?: boolean };

export interface VoiceProvider {
  generate(scene: Scene): Promise<VoiceResult>;
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
  /** What has won controlled tests for this brand before. */
  learnings?: Learning[];
}

/** Returns untrusted plans. The service validates every one with the diff engine before using it. */
export interface VariantProvider {
  generate(input: VariantInput): Promise<unknown[]>;
}
