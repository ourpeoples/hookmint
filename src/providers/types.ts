import type { AspectRatio, BrandKit, Scene, ScenePlan } from "../core/schemas.js";

export interface ScriptInput {
  prompt: string;
  duration_s: number;
  aspect_ratios: AspectRatio[];
  brand?: BrandKit;
}

export interface ScriptProvider {
  generate(input: ScriptInput): Promise<ScenePlan>;
}

export interface VisualProvider {
  generate(scene: Scene): Promise<{ url: string; provider: string }>;
}

export interface VoiceProvider {
  generate(scene: Scene): Promise<{ url: string; provider: string }>;
}

export interface Renderer {
  render(args: {
    plan: ScenePlan;
    aspect: AspectRatio;
    assets: Record<string, { visual_url: string; voice_url: string }>;
    brand?: BrandKit;
  }): Promise<{ url: string }>;
}

export interface Providers {
  script: ScriptProvider;
  visual: VisualProvider;
  voice: VoiceProvider;
  renderer: Renderer;
  variants: VariantProvider;
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
