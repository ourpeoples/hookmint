import type { ScenePlan } from "../core/schemas.js";

const MAX = 160;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** The text of the one idea a variant group tests, as it appears in a plan. This is what an insight quotes. */
export function testedValue(plan: ScenePlan, variable: string): string {
  switch (variable) {
    case "hook":
      return clip(plan.hook);
    case "hook_type":
      return plan.hook_type ?? clip(plan.hook);
    case "angle":
      return clip(plan.angle);
    case "cta":
      return clip(plan.cta.text);
    case "offer": {
      const last = plan.scenes.at(-1);
      return clip(last?.on_screen_text || last?.voiceover || "");
    }
    case "visual_style": {
      const first = plan.scenes[0]?.visual_prompt ?? "";
      const i = first.indexOf("| style:");
      return clip(i >= 0 ? first.slice(i + "| style:".length).trim() : first);
    }
    default:
      return "";
  }
}
