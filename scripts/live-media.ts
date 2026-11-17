/**
 * Live check of the stock footage and voice providers. Not part of `npm test`: it needs real keys, uses a few
 * Pexels searches (free, 200 an hour) and one short text-to-speech request (a fraction of a cent).
 *
 *   PEXELS_API_KEY=... OPENAI_API_KEY=... npm run test:live:media
 *
 * It checks the things the offline tests can only assume: that the Pexels header format and media hosts are what
 * we expect, that a real clip downloads and passes our media checks, and that the speech model and voice names are
 * accepted and return audio that ffprobe accepts. Keys are never printed.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaIngestor } from "../src/net/ingest.js";
import { SafeFetcher } from "../src/net/safe-fetch.js";
import { OpenAIVoiceProvider } from "../src/providers/openai-voice.js";
import { PexelsVisualProvider } from "../src/providers/pexels.js";
import { createStubProviders } from "../src/providers/stub.js";
import type { Scene } from "../src/core/schemas.js";

const env = process.env;
const pexelsKey = env.PEXELS_API_KEY?.trim();
const openaiKey = env.OPENAI_API_KEY?.trim();
if (!pexelsKey && !openaiKey) {
  console.error("Set PEXELS_API_KEY and/or OPENAI_API_KEY.\nRun: PEXELS_API_KEY=... OPENAI_API_KEY=... npm run test:live:media");
  process.exit(2);
}
const root = mkdtempSync(path.join(os.tmpdir(), "hookmint-live-media-"));
const ing = new MediaIngestor(new SafeFetcher(), root);
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};
const scene = (id: string, visual_prompt: string, voiceover = "Your weekend back, starting today."): Scene => ({ id, duration_s: 4, visual_prompt, visual_source: "stock", voiceover, claims: [] });
const say = (e: unknown) => (e instanceof Error ? e.message : String(e));

if (pexelsKey) {
  console.log("Pexels");
  const stub = createStubProviders();
  for (const media of ["video", "photo"] as const) {
    const p = new PexelsVisualProvider({ apiKey: pexelsKey, media, orientation: env.HOOKMINT_PEXELS_ORIENTATION === "landscape" ? "landscape" : "portrait", fallback: stub.visual });
    for (const [i, prompt] of ["A happy family relaxing in a bright clean living room", "Cleaner wiping a kitchen counter", "Sunny suburban house exterior"].entries()) {
      try {
        const r = await p.generate(scene(`s${i + 1}`, prompt));
        console.log(`   ${media} "${prompt}" -> ${new URL(r.url).host}${new URL(r.url).pathname.slice(0, 40)} (${r.kind})`);
        const file = r.kind === "video" ? await ing.video("acct_live", r.url) : await ing.image("acct_live", r.url);
        check(true, `${media} #${i + 1}: found, downloaded and passed our media checks (${path.basename(file)})`);
      } catch (e) {
        check(false, `${media} #${i + 1}: ${say(e)}`);
      }
    }
  }
}

if (openaiKey) {
  console.log("\nOpenAI speech");
  try {
    const v = new OpenAIVoiceProvider({ apiKey: openaiKey, model: env.HOOKMINT_TTS_MODEL?.trim() || undefined, voice: env.HOOKMINT_TTS_VOICE?.trim() || undefined });
    const r = await v.generate(scene("s1", "unused"));
    if (!("audio" in r)) throw new Error("expected audio bytes");
    console.log(`   ${r.provider}, ${r.audio.length} bytes`);
    check(true, "speech request accepted");
    const file = await ing.audioBytes("acct_live", r.audio, r.format);
    check(true, `audio passed our ffprobe checks (${path.basename(file)})`);
  } catch (e) {
    check(false, say(e));
  }
}

console.log(failures ? `\n${failures} check(s) failed. Fix the setting named in the message (key, model or voice) and run again.` : "\nAll live checks passed. Listen to the audio and look at the clips yourself before relying on them.");
console.log(`Files are in ${root}`);
process.exit(failures ? 1 : 0);
