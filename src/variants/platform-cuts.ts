import { AdError } from "../core/errors.js";
import { PLATFORM_RULES, PLATFORMS, type Platform } from "../core/platforms.js";

/**
 * A "platform" test adapts one ad for different platforms: the hook lands inside that platform's window and the on-screen text suits how
 * it is watched. The server chooses which platform each variant is for (the next ones in order, skipping the base ad's own and any whose
 * length limit is shorter than the ad), so the model never decides it, and only the opening and the on-screen text may change.
 */
export function assignPlatforms(base: Platform | undefined, used: (Platform | undefined)[], count: number, totalSeconds: number): Platform[] {
  const taken = new Set<Platform>([...(base ? [base] : []), ...used.filter((p): p is Platform => !!p)]);
  const free = PLATFORMS.filter((p) => !taken.has(p) && PLATFORM_RULES[p].max_duration_s >= totalSeconds);
  if (free.length < count) {
    const tooLong = PLATFORMS.filter((p) => PLATFORM_RULES[p].max_duration_s < totalSeconds && !taken.has(p)).map((p) => PLATFORM_RULES[p].label);
    throw new AdError(
      "invalid_input",
      `Only ${free.length} platform${free.length === 1 ? " is" : "s are"} left to adapt this ad for${free.length ? ` (${free.join(", ")})` : ""}; ${count} ${count === 1 ? "was" : "were"} asked for.` +
        (tooLong.length ? ` ${tooLong.join(" and ")} cannot take an ad of ${totalSeconds} seconds.` : ""),
      undefined,
      { retry: false },
    );
  }
  return free.slice(0, count);
}
