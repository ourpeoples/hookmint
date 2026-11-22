/**
 * Makes short voice samples so you can HEAR a voice and a delivery style before rendering anything. Each sample is one
 * speech request (a fraction of a cent). Files go to ./voice-samples/ (not committed). Keys are never printed.
 *
 *   OPENAI_API_KEY=... npm run voice:sample
 *   OPENAI_API_KEY=... npm run voice:sample -- --voices alloy,marin,cedar --styles neutral,natural "Your own line to try."
 *
 * Styles: neutral (no instructions), brisk, natural (the default Hookmint uses). A voice the API does not accept is reported, not fatal.
 * Set the one you like on the server with HOOKMINT_TTS_VOICE (and change the default style in src/providers/openai-voice.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OpenAIVoiceProvider, VOICE_STYLES } from "../src/providers/openai-voice.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.error("Set OPENAI_API_KEY (for example: OPENAI_API_KEY=... npm run voice:sample).");
  process.exit(2);
}
const flagValues = new Set(["--voices", "--styles"].flatMap((f) => (process.argv.includes(f) ? [process.argv[process.argv.indexOf(f) + 1]] : [])));
const lines = process.argv.slice(2).filter((a) => !a.startsWith("--") && !flagValues.has(a));
const texts = lines.length ? lines : ["Put the mop down. Open Akye.", "Run a small cleaning business? Akye helps you schedule jobs, then send invoices."];
const voices = (arg("voices") ?? "alloy,marin").split(",").map((s) => s.trim()).filter(Boolean);
const styles = (arg("styles") ?? "neutral,natural").split(",").map((s) => s.trim()).filter(Boolean);
for (const s of styles) if (!(s in VOICE_STYLES)) {
  console.error(`Unknown style "${s}". Styles: ${Object.keys(VOICE_STYLES).join(", ")}.`);
  process.exit(2);
}
const dir = path.resolve("voice-samples");
mkdirSync(dir, { recursive: true });

let made = 0;
for (const voice of voices) {
  for (const style of styles) {
    const provider = new OpenAIVoiceProvider({ apiKey: key, voice, instructions: VOICE_STYLES[style as keyof typeof VOICE_STYLES] });
    for (const [i, text] of texts.entries()) {
      const file = path.join(dir, `${voice}-${style}-${i + 1}.mp3`);
      try {
        const r = await provider.generate({ id: "s1", duration_s: 4, visual_prompt: "x", visual_source: "stock", voiceover: text, claims: [] });
        if (!("audio" in r)) throw new Error("no audio returned");
        writeFileSync(file, r.audio);
        console.log(`made  ${path.relative(process.cwd(), file)}   "${text}"`);
        made++;
      } catch (e) {
        console.log(`FAIL  ${voice} / ${style}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
console.log(`\n${made} sample(s) in ${path.relative(process.cwd(), dir) || "."}/. Open them in the file list and listen; the file name says the voice and style.`);
process.exit(made ? 0 : 1);
