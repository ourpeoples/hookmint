import type { ScenePlan } from "../core/schemas.js";

export const TESTED_VARIABLES = ["hook", "angle", "offer", "cta", "visual_style"] as const;
export type TestedVariable = (typeof TESTED_VARIABLES)[number];

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/** Below this word-level distance, two texts count as near-duplicates. A starting value to tune with real data. */
export const DEFAULT_MIN_DISTANCE = 0.2;

/** Identifiers are not content: they never count toward how different two variants read. */
const ID_PATHS = new Set(["hook_id"]);
const SCENE_ID = /^[A-Za-z0-9_-]+$/;
const SCENE_PATH = /^scenes\[([^\]]+)\]\.(\w+)$/;

/** Every comparable field of a plan as `path -> value`. Scenes are keyed by id so reordering shows up as a diff. */
export function flatten(plan: ScenePlan): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema_version: plan.schema_version,
    "template.id": plan.template.id,
    "template.version": plan.template.version,
    hook: plan.hook,
    hook_id: plan.hook_id,
    angle: plan.angle,
    variant_group_id: plan.variant_group_id,
    "cta.text": plan.cta.text,
    "cta.url": plan.cta.url ?? null,
    aspect_ratios: plan.aspect_ratios.join(","),
    "scenes.order": plan.scenes.map((s) => s.id).join(","),
  };
  for (const s of plan.scenes) {
    out[`scenes[${s.id}].duration_s`] = s.duration_s;
    out[`scenes[${s.id}].visual_prompt`] = s.visual_prompt;
    out[`scenes[${s.id}].visual_source`] = s.visual_source;
    out[`scenes[${s.id}].voiceover`] = s.voiceover;
    out[`scenes[${s.id}].on_screen_text`] = s.on_screen_text ?? null;
    out[`scenes[${s.id}].claims`] = JSON.stringify(s.claims);
  }
  return out;
}

export function diffPlans(base: ScenePlan, variant: ScenePlan): DiffEntry[] {
  const a = flatten(base);
  const b = flatten(variant);
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return paths
    .filter((p) => JSON.stringify(a[p] ?? null) !== JSON.stringify(b[p] ?? null))
    .map((p) => ({ path: p, from: a[p] ?? null, to: b[p] ?? null }));
}

/** Which paths may differ when `variable` is the thing being tested. Everything else must match the base exactly. */
export function allowedPaths(variable: TestedVariable, base: ScenePlan): (path: string) => boolean {
  const first = base.scenes[0].id;
  const sceneField = (path: string, fields: string[], onlyScene?: string) => {
    const m = SCENE_PATH.exec(path);
    return !!m && fields.includes(m[2]) && (onlyScene === undefined || m[1] === onlyScene);
  };
  switch (variable) {
    case "hook":
      return (p) => p === "hook" || p === "hook_id" || sceneField(p, ["voiceover", "on_screen_text"], first);
    case "angle":
      return (p) => p === "angle" || p === "hook" || sceneField(p, ["voiceover", "on_screen_text", "claims"]);
    case "offer":
      return (p) => sceneField(p, ["voiceover", "on_screen_text", "claims"]);
    case "cta":
      return (p) => p === "cta.text" || p === "cta.url";
    case "visual_style":
      return (p) => sceneField(p, ["visual_prompt", "visual_source"]);
  }
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

/** Word-set (Jaccard) distance: 0 = same words, 1 = no words in common. */
export function textDistance(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return 1 - shared / (A.size + B.size - shared);
}

/** The text a variant contributes to the tested variable, for comparing variants with each other. */
export function fingerprint(plan: ScenePlan, variable: TestedVariable, base: ScenePlan): string {
  const ok = allowedPaths(variable, base);
  const flat = flatten(plan);
  return Object.keys(flat)
    .filter((p) => ok(p) && !ID_PATHS.has(p))
    .sort()
    .map((p) => String(flat[p] ?? ""))
    .join(" | ");
}

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

export type VariantCheck =
  | { ok: true; diff: DiffEntry[] }
  | { ok: false; reason: string; offending: string[] };

/** Proves `variant` differs from `base` only within the tested variable, and by enough to be a real alternative. */
export function checkVariant(
  base: ScenePlan,
  variant: ScenePlan,
  variable: TestedVariable,
  minDistance = DEFAULT_MIN_DISTANCE,
): VariantCheck {
  for (const s of [...base.scenes, ...variant.scenes]) {
    if (!SCENE_ID.test(s.id)) return { ok: false, reason: `scene id "${s.id}" must use letters, digits, _ or - only`, offending: [] };
  }
  const diff = diffPlans(base, variant);
  const allowed = allowedPaths(variable, base);
  const offending = diff.filter((d) => !allowed(d.path)).map((d) => d.path);
  if (offending.length) {
    return { ok: false, reason: `changes fields outside "${variable}": ${offending.slice(0, 5).join(", ")}${offending.length > 5 ? ", ..." : ""}`, offending };
  }
  if (diff.every((e) => ID_PATHS.has(e.path))) return { ok: false, reason: "is identical to the base", offending: [] };
  const content = diff.filter((e) => !ID_PATHS.has(e.path));
  const d = textDistance(content.map((e) => text(e.from)).join(" "), content.map((e) => text(e.to)).join(" "));
  if (d < minDistance) {
    return { ok: false, reason: `is too similar to the base (word distance ${d.toFixed(2)}, minimum ${minDistance})`, offending: [] };
  }
  return { ok: true, diff };
}
