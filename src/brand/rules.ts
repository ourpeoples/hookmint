import { z } from "zod";
import { AdError } from "../core/errors.js";

export const RuleType = z.enum(["banned_phrase", "regex", "required_disclaimer", "forbidden_claim", "semantic"]);
export type RuleType = z.infer<typeof RuleType>;
export const Severity = z.enum(["info", "warn", "block"]);
export type Severity = z.infer<typeof Severity>;

export const RuleInput = z.object({
  type: RuleType,
  pattern: z.string().min(1).max(200).describe("Phrase, regex, disclaimer text, or (for semantic rules) a plain-language instruction"),
  severity: Severity.optional().describe("Defaults: banned_phrase warn, regex warn, forbidden_claim block, required_disclaimer block, semantic warn"),
  message: z.string().max(300).optional(),
});
export type RuleInput = z.infer<typeof RuleInput>;

export const ExampleInput = z.object({
  kind: z.enum(["tone", "past_winner"]),
  text: z.string().min(1).max(1000),
});
export type ExampleInput = z.infer<typeof ExampleInput>;

export interface Rule {
  id: string;
  type: RuleType;
  pattern: string;
  severity: Severity;
  message?: string;
}

export interface RuleSet {
  account_id: string;
  version: number;
  rules: Rule[];
  examples: ExampleInput[];
}

const DEFAULT_SEVERITY: Record<RuleType, Severity> = {
  banned_phrase: "warn",
  regex: "warn",
  forbidden_claim: "block",
  required_disclaimer: "block",
  semantic: "warn",
};

// Best-effort guard against catastrophic regexes: nested quantifiers and backreferences.
// Plan text is short and capped, which limits the damage of anything this misses.
const RISKY_REGEX = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]|\\[1-9]/;

export function buildRules(inputs: RuleInput[]): Rule[] {
  return inputs.map((r, i) => {
    if (r.type === "regex") {
      if (RISKY_REGEX.test(r.pattern)) {
        throw new AdError("invalid_input", `Rule ${i + 1}: this regex uses nested quantifiers or backreferences, which are not allowed.`);
      }
      try {
        new RegExp(r.pattern, "gi");
      } catch {
        throw new AdError("invalid_input", `Rule ${i + 1}: invalid regular expression.`);
      }
    }
    if (r.type === "semantic" && r.severity === "block") {
      throw new AdError("invalid_input", `Rule ${i + 1}: semantic rules are advisory and cannot block. Use warn or info.`);
    }
    return { id: `r${i + 1}`, type: r.type, pattern: r.pattern, severity: r.severity ?? DEFAULT_SEVERITY[r.type], message: r.message };
  });
}
