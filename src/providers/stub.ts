import { AdError } from "../core/errors.js";
import { PLAN_SCHEMA_VERSION, type Scene, type ScenePlan } from "../core/schemas.js";
import type { Providers } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StubOptions {
  delayMs?: number;
  /** Make the first N visual calls fail with a transient error (tests retry and dedupe). */
  failVisualTimes?: number;
  /** Simulate a variant provider that breaks the rules: change a field it must not touch. */
  variantLeak?: "duration" | "cta" | "aspect" | "scene_order";
  /** Simulate a variant provider that returns the same variant twice, or a near-copy of the base. */
  variantDuplicate?: "twice" | "near_copy";
}

export type StubProviders = Providers & {
  calls: { script: number; visual: number; voice: number; render: number; variants: number };
};

const HOOKS = ["Your weekend back, starting today", "Stop scrubbing and start living", "The clean your friends keep asking about", "One call and the whole house shines", "Skip the chores this spring"];
const ANGLES = [
  { angle: "price", line: "Fair flat rates and no surprise fees" },
  { angle: "social proof", line: "Hundreds of neighbours already trust us" },
  { angle: "urgency", line: "Only a few openings left this week" },
  { angle: "convenience", line: "We handle everything while you relax" },
  { angle: "trust", line: "Vetted, insured and background checked crews" },
];
const OFFERS = ["Ten percent off the first clean", "A free add-on with your first booking", "Book three visits and get one free", "A free quote in sixty seconds", "A no-contract trial month"];
const CTAS = ["Book your clean today", "Get a free quote", "Call now to reserve", "See open dates this week", "Claim your spot"];
const STYLES = [
  "warm handheld documentary look with soft daylight",
  "bright minimal studio look with clean white backdrops",
  "cinematic slow motion with deep contrast and shadows",
  "before and after split screen with bold labels",
  "fast time lapse with upbeat energetic cuts",
];

function makeVariant(base: ScenePlan, variable: string, i: number): ScenePlan {
  const v = structuredClone(base);
  const n = i % 5;
  switch (variable) {
    case "hook":
      v.hook = HOOKS[n];
      v.scenes[0].voiceover = `Opening line: ${HOOKS[n]}.`;
      v.scenes[0].on_screen_text = HOOKS[n];
      break;
    case "angle":
      v.angle = ANGLES[n].angle;
      v.hook = `${ANGLES[n].line} for your home`;
      v.scenes.forEach((s, k) => (s.voiceover = `${ANGLES[n].line}, scene ${k + 1}.`));
      break;
    case "offer":
      v.scenes.at(-1)!.on_screen_text = OFFERS[n];
      v.scenes.at(-1)!.claims = [OFFERS[n]];
      v.scenes.at(-1)!.voiceover = `${OFFERS[n]} when you book now.`;
      break;
    case "cta":
      v.cta = { ...v.cta, text: CTAS[n] };
      break;
    case "visual_style":
      v.scenes.forEach((s) => (s.visual_prompt = `${s.visual_prompt} | style: ${STYLES[n]}`));
      break;
  }
  return v;
}

/** Placeholder providers. Replace each with a real implementation behind the same interface. */
export function createStubProviders(opts: StubOptions = {}): StubProviders {
  const delayMs = opts.delayMs ?? Number(process.env.STUB_DELAY_MS ?? 300);
  let visualFailuresLeft = opts.failVisualTimes ?? 0;
  const calls = { script: 0, visual: 0, voice: 0, render: 0, variants: 0 };
  let seq = 0;

  return {
    calls,
    script: {
      async generate({ prompt, duration_s, aspect_ratios, brand }) {
        calls.script++;
        await sleep(delayMs);
        const count = Math.min(8, Math.max(2, Math.round(duration_s / 4)));
        const base = Math.floor(duration_s / count);
        const extra = duration_s - base * count;
        const scenes: Scene[] = Array.from({ length: count }, (_, i) => ({
          id: `s${i + 1}`,
          duration_s: base + (i < extra ? 1 : 0),
          visual_prompt: `Scene ${i + 1} for: ${prompt}`,
          visual_source: "stock",
          voiceover: `Placeholder voiceover for scene ${i + 1}.`,
          on_screen_text: i === 0 ? "Hook" : undefined,
          claims: [],
        }));
        seq++;
        return {
          schema_version: PLAN_SCHEMA_VERSION,
          template: { id: "stub", version: "0.0.0" },
          hook: `Placeholder hook for: ${prompt}`,
          hook_id: `h_${seq}`,
          angle: "problem-solution",
          variant_group_id: `vg_${seq}`,
          cta: { text: brand ? `Choose ${brand.name}` : "Learn more" },
          aspect_ratios,
          scenes,
        };
      },
    },
    visual: {
      async generate(scene) {
        calls.visual++;
        await sleep(delayMs);
        if (visualFailuresLeft > 0) {
          visualFailuresLeft--;
          throw new AdError("provider_unavailable", "stub visual provider is temporarily unavailable");
        }
        return { url: `https://example.invalid/assets/${scene.id}.mp4`, provider: "stub" };
      },
    },
    voice: {
      async generate(scene) {
        calls.voice++;
        await sleep(delayMs);
        return { url: `https://example.invalid/assets/${scene.id}.mp3`, provider: "stub" };
      },
    },
    variants: {
      async generate({ basePlan, tested_variable, count, existing }) {
        calls.variants++;
        await sleep(delayMs);
        // Continue after the variants already in the group so new ones do not repeat them.
        const start = Math.max(0, existing.length - 1);
        const out = Array.from({ length: count }, (_, i) => makeVariant(basePlan, tested_variable, start + i));
        if (opts.variantLeak === "duration") out[0].scenes[0].duration_s += 1;
        if (opts.variantLeak === "cta") out[0].cta = { text: "Leaked CTA change" };
        if (opts.variantLeak === "aspect") out[0].aspect_ratios = ["1:1"];
        if (opts.variantLeak === "scene_order") out[0].scenes.reverse();
        if (opts.variantDuplicate === "twice" && out.length > 1) out[1] = structuredClone(out[0]);
        if (opts.variantDuplicate === "near_copy") {
          out[0] = structuredClone(basePlan);
          out[0].hook = `${basePlan.hook}!`;
          out[0].scenes[0].voiceover = `${basePlan.scenes[0].voiceover}!`;
        }
        return out;
      },
    },
    renderer: {
      async render({ aspect }) {
        calls.render++;
        await sleep(delayMs);
        return { url: `https://example.invalid/renders/${aspect.replace(":", "x")}.mp4` };
      },
    },
  };
}
