import { PLATFORM_RULES } from "../core/platforms.js";
import type { BrandKit, ScenePlan } from "../core/schemas.js";
import { normalize, type Finding } from "./check.js";

/** Bump when a threshold or message below changes, so stored findings from the old wording are not mistaken for new ones. */
export const BUILTIN_RULE_VERSION = 1;
/** Brand cues that show up in this many seconds of an ad count as "early". */
export const EARLY_WINDOW_S = 3;
export const MIN_BRAND_ASSETS = 3;
export const MIN_EARLY_ASSETS = 2;
const MIN_BENEFIT_CHARS = 12;
/**
 * The synthetic voice measured about 1.8 words a second including its lead-in and tail (1.4 to 2.2 across real lines), so scripts are asked for
 * 1.7. This is the point above which a line clearly will not fit its scene.
 */
export const TYPICAL_WORDS_PER_SECOND = 1.7;
export const MAX_SPOKEN_WORDS_PER_SECOND = 2;

export interface KitFacts {
  kit: BrandKit;
  /** True once the logo has been downloaded and will actually appear in the video. */
  logoReady: boolean;
}

/** The distinct brand assets a kit offers: a logo, colours, and anything listed as distinctive. */
export function brandAssets(kit: BrandKit): { type: string; value: string; text: boolean }[] {
  const seen = new Set<string>();
  const out: { type: string; value: string; text: boolean }[] = [];
  const add = (type: string, value: string, text: boolean) => {
    const key = `${type}:${normalize(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, value, text });
  };
  if (kit.logo_url) add("logo", "logo", false);
  if (kit.colors.length) add("color", kit.colors[0], false);
  for (const a of kit.distinctive_assets ?? []) add(a.type, a.value, a.type === "slogan" || a.type === "character" || a.type === "mascot" || a.type === "pack_shot");
  return out;
}

/**
 * Checks that need no brand rules: they hold for every ad. They are deterministic and advisory (warn at most), and they
 * only point at what research on winning ads says matters: a brand that is recognisable early, a stated benefit, a happy
 * ending, and text on screen where the platform shows ads without sound.
 */
export function checkBuiltins(plan: ScenePlan, facts: KitFacts | undefined): Finding[] {
  const base = { rule_version: BUILTIN_RULE_VERSION, method: "deterministic" as const, confidence: null, advisory: true as const, severity: "warn" as const };
  const out: Finding[] = [];
  const first = plan.scenes[0];

  if (plan.platform) {
    const rules = PLATFORM_RULES[plan.platform];
    if (rules.text_overlay_required && !first.on_screen_text?.trim()) {
      out.push({ ...base, rule_id: "builtin.platform_overlay", scene_id: first.id, field: "on_screen_text", evidence_quote: "",
        message: `${rules.label} ads are often watched without sound, but the first scene has no text on screen.`,
        suggested_fix: "Add short on-screen text to the first scene that carries the hook." });
    }
    const total = plan.scenes.reduce((n, s) => n + s.duration_s, 0);
    if (total > rules.max_duration_s) {
      out.push({ ...base, rule_id: "builtin.platform_duration", scene_id: null, field: "scenes", evidence_quote: `${total}s`,
        message: `The ad runs ${total} seconds, longer than the ${rules.max_duration_s} seconds this tool allows for ${rules.label}.`,
        suggested_fix: `Cut the ad to ${rules.max_duration_s} seconds or less.` });
    }
  }

  for (const s of plan.scenes) {
    const spoken = (s.voiceover.match(/\S+/g) ?? []).length;
    const rate = spoken / s.duration_s;
    if (rate > MAX_SPOKEN_WORDS_PER_SECOND) {
      const needs = Math.ceil((spoken / TYPICAL_WORDS_PER_SECOND) * 10) / 10;
      out.push({ ...base, rule_id: "builtin.voice_pace", scene_id: s.id, field: "voiceover", evidence_quote: `${spoken} words in ${s.duration_s}s`,
        message: `Scene ${s.id} has ${spoken} words for ${s.duration_s} seconds (${rate.toFixed(1)} a second). The voice needs about ${needs} seconds, so the scene would be stretched and the ad would run longer than planned.`,
        suggested_fix: `Shorten the line to about ${Math.floor(s.duration_s * TYPICAL_WORDS_PER_SECOND)} words, or give the scene more time.` });
    }
  }

  const benefit = plan.product_benefit?.trim() ?? "";
  if (benefit.length < MIN_BENEFIT_CHARS || normalize(benefit) === normalize(plan.hook) || normalize(benefit) === normalize(plan.cta.text)) {
    out.push({ ...base, rule_id: "builtin.product_benefit", scene_id: null, field: "product_benefit", evidence_quote: benefit,
      message: "The plan does not state a clear product benefit. Ads persuade when the viewer can say what they get.",
      suggested_fix: "Add one sentence naming what the viewer gets, different from the hook and the call to action." });
  }
  if (!(plan.resolution?.trim())) {
    out.push({ ...base, rule_id: "builtin.resolution", scene_id: plan.scenes.at(-1)!.id, field: "resolution", evidence_quote: "",
      message: "The plan does not say how the ad ends well for the viewer.",
      suggested_fix: "Add a short resolution: the outcome the last scene shows." });
  }

  if (facts) {
    const assets = brandAssets(facts.kit);
    if (assets.length < MIN_BRAND_ASSETS) {
      out.push({ ...base, rule_id: "builtin.brand_assets", scene_id: null, field: "brand_kit", evidence_quote: `${assets.length} of ${MIN_BRAND_ASSETS}`,
        message: `The brand kit has ${assets.length} distinctive asset${assets.length === 1 ? "" : "s"}; brands that use ${MIN_BRAND_ASSETS} or more (logo, colour, slogan, character) are remembered better.`,
        suggested_fix: "Add a logo, a slogan, a character or a pack shot to the brand kit (distinctive_assets)." });
    }
    // What a viewer can recognise in the first seconds: the logo and primary colour are drawn from the first frame, and a
    // slogan, character, mascot or pack shot counts when the opening scenes name it.
    let t = 0;
    const early: string[] = [];
    for (const s of plan.scenes) {
      if (t >= EARLY_WINDOW_S) break;
      early.push(s.voiceover, s.on_screen_text ?? "", s.visual_prompt);
      t += s.duration_s;
    }
    const openingText = normalize(early.join(" "));
    const seen = assets.filter((a) => (a.type === "logo" ? facts.logoReady : a.type === "color" ? true : a.text && openingText.includes(normalize(a.value))));
    if (assets.length >= 1 && seen.length < MIN_EARLY_ASSETS) {
      out.push({ ...base, rule_id: "builtin.brand_assets_early", scene_id: first.id, field: "scenes", evidence_quote: `${seen.length} of ${MIN_EARLY_ASSETS}`,
        message: `Only ${seen.length} brand asset${seen.length === 1 ? " shows" : "s show"} in the first ${EARLY_WINDOW_S} seconds; ads that show ${MIN_EARLY_ASSETS} or more early build brand connection.`,
        suggested_fix: "Put the logo, slogan or character in the first scene, and make sure the logo has finished downloading." });
    }
  }
  return out;
}
