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
}
