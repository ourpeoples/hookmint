import { AdError } from "../core/errors.js";
import type { Scene } from "../core/schemas.js";
import { providerRequest, type ProviderHttp } from "./http.js";
import type { VoiceProvider, VoiceResult } from "./types.js";

export const OPENAI_BASE_URL = "https://api.openai.com";
/** Longest text one speech request accepts, per OpenAI's documentation at the time of writing. */
export const MAX_SPEECH_CHARS = 4096;

export interface OpenAIVoiceOptions {
  apiKey: string;
  /** Not read from OPENAI_BASE_URL on purpose: that variable may point at some other gateway. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Model and voice names are settings because providers rename them. They are unverified defaults until `npm run test:live` passes. */
  model?: string;
  voice?: string;
  /** How to deliver the line (models that take instructions only). Brisk by default, so lines fit their scenes. Set to "" to send none. */
  instructions?: string;
  timeoutMs?: number;
}

/** Named ways to deliver a line, for the sample command and for choosing a default. Only models that take instructions use them. */
export const VOICE_STYLES = {
  neutral: "",
  brisk: "Speak at a brisk, confident pace like a social video narrator, warm and natural. Keep pauses between sentences short and do not trail off at the end.",
  natural:
    "Talk like a friendly, relaxed person speaking to one small business owner, not like an announcer. Natural everyday pace. Stress only the one or two words that matter in each sentence, let the pitch fall at the end of a statement and rise gently for a question, pause briefly at commas and full stops, and never read punctuation or labels aloud.",
} as const;
export const DEFAULT_VOICE_INSTRUCTIONS: string = VOICE_STYLES.natural;

/**
 * Text to speech through OpenAI's speech endpoint. The voice is synthetic, so every result is flagged `ai_generated`
 * and the service records that in the finished video's provenance. Providers' usage rules require telling listeners
 * a voice is AI generated; the service shows that notice with every ad that uses it.
 *
 * Returns the audio bytes themselves. The service stores them through the media ingestor, which checks them with ffprobe
 * like any other audio, and the renderer reads them from the local asset folder.
 */
export class OpenAIVoiceProvider implements VoiceProvider {
  private cfg: ProviderHttp;
  private base: string;
  private model: string;
  private voice: string;
  private instructions: string;

  constructor(private opts: OpenAIVoiceOptions) {
    if (!opts.apiKey) throw new Error("OpenAIVoiceProvider needs an apiKey");
    this.base = (opts.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? "gpt-4o-mini-tts";
    this.voice = opts.voice ?? "alloy";
    this.instructions = opts.instructions ?? DEFAULT_VOICE_INSTRUCTIONS;
    this.cfg = { name: "OpenAI speech", keyVar: "OPENAI_API_KEY", fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 60_000, maxBytes: 10 * 1024 * 1024 };
  }

  async generate(scene: Scene): Promise<VoiceResult> {
    const text = scene.voiceover.trim();
    if (!text) throw new AdError("invalid_input", `Scene ${scene.id} has no voiceover text.`, undefined, { retry: false });
    if (text.length > MAX_SPEECH_CHARS) throw new AdError("invalid_input", `Scene ${scene.id}'s voiceover is longer than ${MAX_SPEECH_CHARS} characters.`, undefined, { retry: false });
    const reply = await providerRequest(this.cfg, `${this.base}/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: "mp3", ...(this.instructions && /^gpt-4o/.test(this.model) ? { instructions: this.instructions } : {}) }),
    });
    if (reply.bytes.length < 200) throw new AdError("provider_unavailable", "OpenAI speech returned an empty or truncated audio file.");
    return { audio: reply.bytes, format: "mp3", provider: `openai:${this.model}`, voice: this.voice, ai_generated: true };
  }
}
