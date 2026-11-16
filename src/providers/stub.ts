import { AdError } from "../core/errors.js";
import { PLAN_SCHEMA_VERSION, type Scene } from "../core/schemas.js";
import type { Providers } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StubOptions {
  delayMs?: number;
  /** Make the first N visual calls fail with a transient error (tests retry and dedupe). */
  failVisualTimes?: number;
}

export type StubProviders = Providers & {
  calls: { script: number; visual: number; voice: number; render: number };
};

/** Placeholder providers. Replace each with a real implementation behind the same interface. */
export function createStubProviders(opts: StubOptions = {}): StubProviders {
  const delayMs = opts.delayMs ?? Number(process.env.STUB_DELAY_MS ?? 300);
  let visualFailuresLeft = opts.failVisualTimes ?? 0;
  const calls = { script: 0, visual: 0, voice: 0, render: 0 };
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
    renderer: {
      async render({ aspect }) {
        calls.render++;
        await sleep(delayMs);
        return { url: `https://example.invalid/renders/${aspect.replace(":", "x")}.mp4` };
      },
    },
  };
}
