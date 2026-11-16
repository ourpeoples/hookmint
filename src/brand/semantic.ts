import type { ScenePlan } from "../core/schemas.js";
import { type Finding, normalize, textFields } from "./check.js";
import type { Rule, Severity } from "./rules.js";

/** What a model-based checker must return. Anything that does not validate is discarded. */
export interface RawSemanticFinding {
  rule_id: string;
  severity: Severity;
  scene_id?: string | null;
  evidence_quote: string;
  message: string;
  suggested_fix?: string;
  confidence: "low" | "medium" | "high";
}

export interface SemanticChecker {
  /** Called with rule text and plan text as data. An implementation must not be given tools. */
  check(input: { plan: ScenePlan; rules: Rule[] }): Promise<RawSemanticFinding[]>;
}

/**
 * Keeps only findings that cite a real semantic rule and quote text that appears verbatim in the plan.
 * Severity is capped at warn: a model can advise but never block.
 */
export function validateSemantic(
  raw: RawSemanticFinding[],
  plan: ScenePlan,
  rules: Rule[],
  ruleVersion: number,
): { findings: Finding[]; discarded: number } {
  const semantic = new Map(rules.filter((r) => r.type === "semantic").map((r) => [r.id, r]));
  const fields = textFields(plan);
  const sceneIds = new Set(plan.scenes.map((s) => s.id));
  const findings: Finding[] = [];
  let discarded = 0;

  for (const r of raw) {
    const rule = semantic.get(r.rule_id);
    const quote = normalize(r.evidence_quote ?? "");
    const field = quote ? fields.find((f) => normalize(f.text).includes(quote) && (r.scene_id == null || f.scene_id === r.scene_id)) : undefined;
    const scene = r.scene_id ?? null;
    const ok =
      rule &&
      field &&
      ["low", "medium", "high"].includes(r.confidence) &&
      (scene === null || sceneIds.has(scene));
    if (!ok) {
      discarded++;
      continue;
    }
    findings.push({
      severity: r.severity === "info" ? "info" : "warn",
      rule_id: rule.id,
      rule_version: ruleVersion,
      method: "llm",
      confidence: r.confidence,
      scene_id: field.scene_id,
      field: field.field,
      evidence_quote: r.evidence_quote,
      message: r.message,
      suggested_fix: r.suggested_fix ?? "Reword to fit the rule.",
      advisory: true,
    });
  }
  return { findings, discarded };
}
