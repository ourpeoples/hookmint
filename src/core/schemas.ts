import { z } from "zod";
import { PLATFORMS } from "./platforms.js";

export const AspectRatio = z.enum(["9:16", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const PlatformSchema = z.enum(PLATFORMS);

export const PLAN_SCHEMA_VERSION = "1.1" as const;
export const RESULT_SCHEMA_VERSION = 1 as const;

export const Scene = z.object({
  id: z.string(),
  duration_s: z.number().min(1).max(10),
  visual_prompt: z.string(),
  visual_source: z.enum(["stock", "image_gen", "video_gen", "upload"]),
  voiceover: z.string(),
  on_screen_text: z.string().optional(),
  claims: z.array(z.string()).default([]),
});
export type Scene = z.infer<typeof Scene>;

export const VariantDefinition = z.object({
  tested_variable: z.enum(["hook", "angle", "offer", "cta", "visual_style"]),
  base_ad_id: z.string(),
  diff: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })), // computed by the diff engine, never model-written
});
export type VariantDefinition = z.infer<typeof VariantDefinition>;

export const ScenePlan = z.object({
  schema_version: z.literal(PLAN_SCHEMA_VERSION),
  template: z.object({ id: z.string(), version: z.string() }),
  hook: z.string(),
  hook_id: z.string(),
  angle: z.string(),
  variant_group_id: z.string(),
  variant: VariantDefinition.optional(),
  cta: z.object({ text: z.string(), url: z.string().url().optional() }),
  /** Where the ad will run. Set by the server from the request, never by a model. */
  platform: PlatformSchema.optional(),
  /** The concrete benefit the viewer gets, in one sentence. Persuasion depends on it, so the brand check asks for it. */
  product_benefit: z.string().max(200).optional(),
  /** How the ad ends well for the viewer. */
  resolution: z.string().max(200).optional(),
  aspect_ratios: z.array(AspectRatio).min(1),
  scenes: z.array(Scene).min(2).max(8),
});
export type ScenePlan = z.infer<typeof ScenePlan>;

/** Upgrade plans written before schema_version existed (1.0) to the current shape. */
export function upgradePlan(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !("schema_version" in raw)) {
    return {
      schema_version: PLAN_SCHEMA_VERSION,
      template: { id: "default", version: "0.0.0" },
      hook_id: "h_legacy",
      angle: "unspecified",
      variant_group_id: "vg_legacy",
      ...(raw as object),
    };
  }
  return raw;
}

/** Things a viewer learns to recognise a brand by. A logo and colours are already in the kit; these are the rest. */
export const ASSET_TYPES = ["logo", "color", "slogan", "character", "mascot", "pack_shot"] as const;
export const DistinctiveAsset = z.object({ type: z.enum(ASSET_TYPES), value: z.string().min(1).max(100) });
export type DistinctiveAsset = z.infer<typeof DistinctiveAsset>;

export const BrandKit = z.object({
  id: z.string(),
  name: z.string(),
  logo_url: z.string().url().optional(),
  colors: z.array(z.string()).default([]),
  font: z.string().optional(),
  tone: z.string().optional(),
  distinctive_assets: z.array(DistinctiveAsset).max(10).optional(),
});
export type BrandKit = z.infer<typeof BrandKit>;

export type JobStatus =
  | "scripting"
  | "awaiting_approval"
  | "generating"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export function totalDuration(plan: ScenePlan): number {
  return plan.scenes.reduce((sum, s) => sum + s.duration_s, 0);
}
