import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Silence after the last word, so a line does not end on the cut to the next scene. */
export const VOICE_TAIL_S = 0.4;
/** The most a scene is lengthened to fit its line. A longer line is cut at this point and the notes say so. */
export const MAX_EXTRA_S = 6;

export interface FitResult {
  /** Seconds each scene should last, in the order given. */
  durations: number[];
  /** Scenes that had to be lengthened, with the length the plan gave them. */
  lengthened: { id: string; from: number; to: number; voice: number }[];
  /** Scenes whose voice is still longer than the scene after the cap. */
  tooLong: string[];
}

/**
 * Keeps each scene on screen until its voice has finished. A scene is never shortened, because the plan's durations are the
 * promise the customer was shown, and each lengthening is rounded up to a tenth of a second.
 */
export function fitSceneDurations(scenes: { id: string; duration_s: number }[], voice: Record<string, number | undefined>): FitResult {
  const durations: number[] = [];
  const lengthened: FitResult["lengthened"] = [];
  const tooLong: string[] = [];
  for (const s of scenes) {
    const v = voice[s.id];
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) {
      durations.push(s.duration_s);
      continue;
    }
    const needed = Math.ceil((v + VOICE_TAIL_S) * 10) / 10;
    if (needed <= s.duration_s) {
      durations.push(s.duration_s);
      continue;
    }
    const to = Math.min(needed, s.duration_s + MAX_EXTRA_S);
    if (to < needed) tooLong.push(s.id);
    lengthened.push({ id: s.id, from: s.duration_s, to, voice: v });
    durations.push(to);
  }
  return { durations, lengthened, tooLong };
}

/** Length in seconds of a local audio file, or undefined when it cannot be read. The file is local, so ffprobe may open nothing else. */
export async function audioSeconds(file: string): Promise<number | undefined> {
  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const ffprobe = RenderInternals.getExecutablePath({ type: "ffprobe", indent: false, logLevel: "error", binariesDirectory: null });
    const { stdout } = await run(ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "json", file], { timeout: 15_000, maxBuffer: 100_000 });
    const secs = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration);
    return Number.isFinite(secs) && secs > 0 ? secs : undefined;
  } catch {
    return undefined;
  }
}
