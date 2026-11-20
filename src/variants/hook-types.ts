import { AdError } from "../core/errors.js";

/**
 * The ways an ad can open. A "hook_type" test writes the same ad with a different kind of opening, so what is learned is about the
 * kind of hook (does naming the audience beat opening on the result?) and carries over to other ads, not just to one sentence.
 */
export const HOOK_TYPES = ["identity", "product", "pattern_interrupt", "trend", "result_first"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/** What each type means, in words a model can follow. Sent as data with every script and every hook_type test. */
export const HOOK_TYPE_GUIDE: Record<HookType, string> = {
  identity: "Speaks to who the viewer is, so the right person thinks 'that is me', for example by naming the audience or their situation.",
  product: "Opens on the product doing its job, named or shown in the very first moment.",
  pattern_interrupt: "Opens with something unexpected in the words or the picture that breaks the scroll, then ties it to the product.",
  trend: "Opens in a familiar native format of the platform, such as a 'POV:' or 'things I wish I knew' line, without inventing a claim.",
  result_first: "Opens with the outcome the viewer wants, before saying how to get it.",
};

/**
 * Chooses which type each new variant tests: types not used by the base or by any variant already in the group, in the fixed order above, so
 * every variant in a test has its own type and the server, not the model, decides what each one is. The model is asked to write each
 * type; whether the words really are that type is advice the customer can see, not something a program can prove.
 */
export function assignHookTypes(base: HookType | undefined, used: (HookType | undefined)[], count: number): HookType[] {
  const taken = new Set<HookType>([...(base ? [base] : []), ...used.filter((t): t is HookType => !!t)]);
  const free = HOOK_TYPES.filter((t) => !taken.has(t));
  if (free.length < count) {
    throw new AdError(
      "invalid_input",
      `Only ${free.length} hook type${free.length === 1 ? " is" : "s are"} left to test for this ad${free.length ? ` (${free.join(", ")})` : ""}; ${count} ${count === 1 ? "was" : "were"} asked for. Each variant tests a different type.`,
      undefined,
      { retry: false },
    );
  }
  return free.slice(0, count);
}
