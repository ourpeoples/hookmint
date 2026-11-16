import { z } from "zod";

export const AspectRatio = z.enum(["9:16", "1:1", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

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

export const ScenePlan = z.object({
  schema_version: z.literal(PLAN_SCHEMA_VERSION),
  template: z.object({ id: z.string(), version: z.string() }),
  hook: z.string(),
  hook_id: z.string(),
  angle: z.string(),
  variant_group_id: z.string(),
  cta: z.object({ text: z.string(), url: z.string().url().optional() }),
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

export const BrandKit = z.object({
  id: z.string(),
  name: z.string(),
  logo_url: z.string().url().optional(),
  colors: z.array(z.string()).default([]),
  font: z.string().optional(),
  tone: z.string().optional(),
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
