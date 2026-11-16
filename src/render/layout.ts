/**
 * Layout rules shared by the video template (runs in a browser) and the Node renderer and tests.
 * Pure functions only: no Node, React or Remotion imports, so it bundles anywhere and tests without a browser.
 */

export type Aspect = "9:16" | "1:1" | "16:9";
export const ASPECTS: Aspect[] = ["9:16", "1:1", "16:9"];
export const FPS = 30;

export const DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/**
 * Fractions of the frame kept clear of text and buttons. Starting values: social feeds overlay their own interface
 * (top bar, bottom captions and buttons) and each platform differs. Confirm against current platform guidelines.
 */
export const SAFE_ZONES: Record<Aspect, { top: number; right: number; bottom: number; left: number }> = {
  "9:16": { top: 0.14, right: 0.08, bottom: 0.22, left: 0.08 },
  "1:1": { top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 },
  "16:9": { top: 0.08, right: 0.06, bottom: 0.1, left: 0.06 },
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function safeRect(aspect: Aspect): Rect {
  const { width, height } = DIMENSIONS[aspect];
  const z = SAFE_ZONES[aspect];
  const x = Math.round(width * z.left);
  const y = Math.round(height * z.top);
  return { x, y, width: Math.round(width * (1 - z.left - z.right)), height: Math.round(height * (1 - z.top - z.bottom)) };
}

/** Text sizes scale with the short side so a 1080x1920 and a 1920x1080 frame read the same. */
export function sizes(aspect: Aspect) {
  const { width, height } = DIMENSIONS[aspect];
  const short = Math.min(width, height);
  return {
    headline: Math.round(short * 0.082),
    headlineMin: Math.round(short * 0.05),
    caption: Math.round(short * 0.042),
    captionMin: Math.round(short * 0.035), // below this, captions are hard to read on a phone
    tag: Math.round(short * 0.036),
    cta: Math.round(short * 0.056),
  };
}

// ---------- timing ----------

export interface TimelineScene {
  id: string;
  startFrame: number;
  durationFrames: number;
  voiceover: string;
  onScreenText: string | null;
  isFirst: boolean;
  isLast: boolean;
}

export interface PlanLite {
  hook: string;
  cta: { text: string };
  scenes: { id: string; duration_s: number; voiceover: string; on_screen_text?: string | null }[];
}

/** Frames per scene. Rounding is absorbed by the last scene so the total is exactly round(total seconds * FPS). */
export function buildTimeline(plan: PlanLite): { scenes: TimelineScene[]; totalFrames: number } {
  const totalFrames = Math.round(plan.scenes.reduce((n, s) => n + s.duration_s, 0) * FPS);
  let start = 0;
  const scenes = plan.scenes.map((s, i) => {
    const last = i === plan.scenes.length - 1;
    const durationFrames = last ? totalFrames - start : Math.max(1, Math.round(s.duration_s * FPS));
    const out: TimelineScene = {
      id: s.id,
      startFrame: start,
      durationFrames,
      voiceover: s.voiceover,
      onScreenText: s.on_screen_text ?? null,
      isFirst: i === 0,
      isLast: last,
    };
    start += durationFrames;
    return out;
  });
  return { scenes, totalFrames };
}

/** The call-to-action shows over the end of the last scene: up to 2.5 s, never more than half of it. */
export function ctaWindow(lastSceneFrames: number): { startFrame: number; durationFrames: number } {
  const durationFrames = Math.max(1, Math.min(Math.round(2.5 * FPS), Math.floor(lastSceneFrames / 2)));
  return { startFrame: lastSceneFrames - durationFrames, durationFrames };
}

// ---------- text fitting ----------

export interface Fit {
  fontSize: number;
  maxLines: number;
  truncated: boolean;
}

/** Average glyph width as a fraction of font size for the bold Inter used here, with room for word-wrap waste. */
const AVG_CHAR_EM = 0.6;

export function estimateLines(text: string, fontSize: number, maxWidth: number): number {
  const perLine = Math.max(1, Math.floor(maxWidth / (AVG_CHAR_EM * fontSize)));
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = word.length;
    if (used === 0) used = w;
    else if (used + 1 + w <= perLine) used += 1 + w;
    else { lines++; used = w; }
    while (used > perLine) { lines++; used -= perLine; } // a single very long word wraps by characters
  }
  return lines;
}

/** Largest font size, not below `min`, at which `text` fits in `maxLines` lines. If even `min` does not fit it is clamped. */
export function fitText(text: string, maxWidth: number, maxLines: number, start: number, min: number): Fit {
  let size = start;
  while (size > min && estimateLines(text, size, maxWidth) > maxLines) size = Math.max(min, Math.floor(size * 0.92));
  return { fontSize: size, maxLines, truncated: estimateLines(text, size, maxWidth) > maxLines };
}

// ---------- colour and contrast (WCAG 2.x relative luminance) ----------

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Brand colours come from users and end up in CSS, so only plain hex values are allowed through. */
export function sanitizeColor(input: string | undefined | null, fallback: string): string {
  const v = (input ?? "").trim();
  if (!HEX.test(v)) return fallback;
  return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase() : v.toLowerCase();
}

export function rgb(hex: string): [number, number, number] {
  const h = sanitizeColor(hex, "#000000").slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * White or black, whichever reads better on `background`. Pure black, not near-black: with #111111 the worst
 * background (a mid-tone) only reaches 4.35:1, below the 4.5:1 standard; with #000000 the worst case is 4.58:1.
 */
export function pickTextColor(background: string): "#ffffff" | "#000000" {
  const bg = rgb(background);
  return contrastRatio(bg, [255, 255, 255]) >= contrastRatio(bg, [0, 0, 0]) ? "#ffffff" : "#000000";
}

/** A darker companion of the brand colour for gradients. */
export function darken(hex: string, amount = 0.45): string {
  const [r, g, b] = rgb(hex).map((c) => Math.round(c * (1 - amount)));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Opacity of the dark box behind captions. The template uses this and a test proves white text stays readable on it. */
export const CAPTION_SCRIM = 0.62;

/** Worst-case contrast of white text on a black scrim of the given opacity, when the video behind is pure white. */
export function captionContrast(scrimOpacity: number): number {
  const bg = Math.round(255 * (1 - scrimOpacity));
  return contrastRatio([255, 255, 255], [bg, bg, bg]);
}

// ---------- advisory notes ----------

export const MAX_WORDS_PER_SECOND = 4;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Plain-language notes about things that will read badly in the finished video. Advisory only. */
export function readabilityNotes(plan: PlanLite, aspect: Aspect): string[] {
  const notes: string[] = [];
  const s = sizes(aspect);
  const rect = safeRect(aspect);
  if (s.caption < s.captionMin) notes.push(`Caption text is smaller than the minimum for ${aspect}.`);
  for (const sc of plan.scenes) {
    const wps = words(sc.voiceover) / sc.duration_s;
    if (wps > MAX_WORDS_PER_SECOND) notes.push(`Scene ${sc.id}: the caption has ${words(sc.voiceover)} words in ${sc.duration_s}s (${wps.toFixed(1)} words a second), faster than most people can read.`);
    const text = sc.on_screen_text ?? "";
    if (text && fitText(text, rect.width, 3, s.headline, s.headlineMin).truncated) notes.push(`Scene ${sc.id}: the on-screen text is too long for the layout and will be shortened.`);
  }
  if (fitText(plan.cta.text, rect.width - 2 * s.cta, 2, s.cta, Math.round(s.cta * 0.6)).truncated) notes.push("The call to action is too long for the button and will be shortened.");
  return notes;
}
