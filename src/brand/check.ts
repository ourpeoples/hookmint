import type { ScenePlan } from "../core/schemas.js";
import type { Rule, Severity } from "./rules.js";

export interface Finding {
  severity: Severity;
  rule_id: string;
  rule_version: number;
  method: "deterministic" | "llm";
  confidence: "low" | "medium" | "high" | null; // null for deterministic findings
  scene_id: string | null; // null = plan level (hook, cta)
  field: string;
  evidence_quote: string;
  message: string;
  suggested_fix: string;
  advisory: true; // findings are advisory and are not legal advice
}

export interface TextField {
  scene_id: string | null;
  field: string;
  text: string;
}

const MAX_TEXT = 2000;
const MAX_MATCHES_PER_FIELD = 5;
const ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

export function textFields(plan: ScenePlan): TextField[] {
  const out: TextField[] = [
    { scene_id: null, field: "hook", text: plan.hook },
    { scene_id: null, field: "cta", text: plan.cta.text },
  ];
  for (const s of plan.scenes) {
    out.push({ scene_id: s.id, field: "voiceover", text: s.voiceover });
    if (s.on_screen_text) out.push({ scene_id: s.id, field: "on_screen_text", text: s.on_screen_text });
    s.claims.forEach((c, i) => out.push({ scene_id: s.id, field: `claims[${i}]`, text: c }));
  }
  return out.map((f) => ({ ...f, text: f.text.slice(0, MAX_TEXT) }));
}

export const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deterministic checks only. Semantic (LLM) rules are skipped here and handled by the semantic validator. */
export function checkPlan(plan: ScenePlan, rules: Rule[], ruleVersion: number): Finding[] {
  const fields = textFields(plan);
  const findings: Finding[] = [];
  const base = { rule_version: ruleVersion, method: "deterministic" as const, confidence: null, advisory: true as const };

  for (const rule of rules) {
    if (rule.type === "semantic") continue;

    if (rule.type === "required_disclaimer") {
      const needle = normalize(rule.pattern);
      const haystack = normalize(fields.filter((f) => f.field !== "hook").map((f) => f.text).join(" "));
      if (!haystack.includes(needle)) {
        const last = plan.scenes.at(-1)!;
        findings.push({
          ...base,
          severity: rule.severity,
          rule_id: rule.id,
          scene_id: null,
          field: "plan",
          evidence_quote: `(missing) ${rule.pattern}`,
          message: rule.message ?? "A required disclaimer is missing.",
          suggested_fix: `Add "${rule.pattern}" to the on-screen text of scene ${last.id}.`,
        });
      }
      continue;
    }

    const re =
      rule.type === "regex"
        ? new RegExp(rule.pattern, "gi")
        : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(rule.pattern)}(?![\\p{L}\\p{N}])`, "giu");
    const label = rule.type === "forbidden_claim" ? "Forbidden claim" : "Banned wording";
    for (const f of fields) {
      let n = 0;
      for (const m of f.text.matchAll(re)) {
        if (m[0].length === 0) continue;
        findings.push({
          ...base,
          severity: rule.severity,
          rule_id: rule.id,
          scene_id: f.scene_id,
          field: f.field,
          evidence_quote: m[0],
          message: rule.message ?? `${label}: "${m[0]}".`,
          suggested_fix: `Remove or reword "${m[0]}" in ${f.scene_id ? `scene ${f.scene_id} ` : ""}${f.field}.`,
        });
        if (++n >= MAX_MATCHES_PER_FIELD) break;
      }
    }
  }
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function summarize(findings: Finding[]) {
  const counts = { block: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const status = counts.block ? "block" : counts.warn ? "warn" : "pass";
  return { status, counts } as const;
}
