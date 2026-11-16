import type { Scene, ScenePlan } from "./schemas.js";

/** Placeholder catalog. Real prices come from a versioned catalog per provider (design doc, M2/M8). */
export const COST_CATALOG_VERSION = "stub-2026-11";
const VISUAL: Record<Scene["visual_source"], number> = { stock: 1, image_gen: 3, video_gen: 10, upload: 0 };
export const VOICE_CREDITS = 1;
export const RENDER_CREDITS_PER_ASPECT = 2;

export interface Estimate {
  credits: number;
  breakdown: { visuals: number; voice: number; render: number };
  catalog_version: string;
}

export const visualCredits = (s: Scene) => VISUAL[s.visual_source];

function sum(scenes: Scene[]) {
  return {
    visuals: scenes.reduce((n, s) => n + visualCredits(s), 0),
    voice: scenes.length * VOICE_CREDITS,
  };
}

/** Cost of approving: generate assets for scenes that lack them, then render every aspect ratio. */
export function estimateApproval(plan: ScenePlan, haveAssets: ReadonlySet<string>): Estimate {
  const { visuals, voice } = sum(plan.scenes.filter((s) => !haveAssets.has(s.id)));
  const render = plan.aspect_ratios.length * RENDER_CREDITS_PER_ASPECT;
  return { credits: visuals + voice + render, breakdown: { visuals, voice, render }, catalog_version: COST_CATALOG_VERSION };
}

export function estimateRegeneration(scene: Scene): Estimate {
  const { visuals, voice } = sum([scene]);
  return { credits: visuals + voice, breakdown: { visuals, voice, render: 0 }, catalog_version: COST_CATALOG_VERSION };
}
