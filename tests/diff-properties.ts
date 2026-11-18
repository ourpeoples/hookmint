import assert from "node:assert/strict";
import { Scene, ScenePlan, type ScenePlan as Plan } from "../src/core/schemas.js";
import { checkVariant, diffPlans, TESTED_VARIABLES, type TestedVariable } from "../src/variants/diff.js";

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

function rng(seed: number) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = "bright clean spring fresh family weekend home sparkle trust simple book today crew vetted insured quick calm shine".split(" ");
let counter = 0;
const fresh = (rand: () => number) => `${WORDS[Math.floor(rand() * WORDS.length)]} ${WORDS[Math.floor(rand() * WORDS.length)]} v${++counter}`;

function randomPlan(rand: () => number): Plan {
  const count = 2 + Math.floor(rand() * 5);
  return ScenePlan.parse({
    schema_version: "1.1",
    template: { id: "default", version: "1.0.0" },
    hook: fresh(rand), hook_id: `h_${counter}`, angle: fresh(rand), variant_group_id: `vg_${counter}`,
    cta: { text: fresh(rand), ...(rand() < 0.5 ? { url: "https://example.com/book" } : {}) },
    aspect_ratios: ["9:16", "1:1"].slice(0, 1 + Math.floor(rand() * 2)),
    scenes: Array.from({ length: count }, (_, i) => ({
      id: `s${i + 1}`, duration_s: 1 + Math.floor(rand() * 5), visual_prompt: fresh(rand), visual_source: (["stock", "image_gen", "video_gen", "upload"] as const)[Math.floor(rand() * 4)],
      voiceover: fresh(rand), ...(rand() < 0.6 ? { on_screen_text: fresh(rand) } : {}), claims: rand() < 0.4 ? [fresh(rand)] : [],
    })),
  });
}

// ---- one way to change each field ----

type Mutation = { name: string; scene?: "first" | "other"; field: string; plan?: true; apply: (p: Plan, rand: () => number) => void };
const sceneAt = (p: Plan, which: "first" | "other") => (which === "first" ? p.scenes[0] : p.scenes[1 + Math.floor(Math.random() * (p.scenes.length - 1))]);
const MUTATIONS: Mutation[] = [
  { name: "hook text", field: "hook", plan: true, apply: (p, r) => { p.hook = fresh(r); } },
  { name: "hook id", field: "hook_id", plan: true, apply: (p, r) => { p.hook_id = `h_${fresh(r)}`; } },
  { name: "angle", field: "angle", plan: true, apply: (p, r) => { p.angle = fresh(r); } },
  { name: "variant group id", field: "variant_group_id", plan: true, apply: (p, r) => { p.variant_group_id = `vg_${fresh(r)}`; } },
  { name: "cta text", field: "cta.text", plan: true, apply: (p, r) => { p.cta.text = fresh(r); } },
  { name: "cta url", field: "cta.url", plan: true, apply: (p) => { p.cta.url = p.cta.url === "https://example.com/a" ? "https://example.com/b" : "https://example.com/a"; } },
  { name: "aspect ratios", field: "aspect_ratios", plan: true, apply: (p) => { p.aspect_ratios = p.aspect_ratios.includes("16:9") ? ["9:16"] : [...p.aspect_ratios, "16:9"]; } },
  { name: "template id", field: "template.id", plan: true, apply: (p, r) => { p.template.id = fresh(r); } },
  { name: "template version", field: "template.version", plan: true, apply: (p, r) => { p.template.version = `9.${fresh(r)}`; } },
  { name: "reorder scenes", field: "scenes.order", plan: true, apply: (p) => { [p.scenes[0], p.scenes[1]] = [p.scenes[1], p.scenes[0]]; } },
  { name: "add a scene", field: "scenes.order", plan: true, apply: (p, r) => { p.scenes.push({ id: `s${p.scenes.length + 1}x`, duration_s: 2, visual_prompt: fresh(r), visual_source: "stock", voiceover: fresh(r), claims: [] }); } },
  ...(["first", "other"] as const).flatMap((which): Mutation[] => [
    { name: `${which} scene duration`, scene: which, field: "duration_s", apply: (p) => { const s = sceneAt(p, which); s.duration_s = s.duration_s >= 9 ? 1 : s.duration_s + 1; } },
    { name: `${which} scene visual prompt`, scene: which, field: "visual_prompt", apply: (p, r) => { sceneAt(p, which).visual_prompt = fresh(r); } },
    { name: `${which} scene visual source`, scene: which, field: "visual_source", apply: (p) => { const s = sceneAt(p, which); s.visual_source = s.visual_source === "stock" ? "upload" : "stock"; } },
    { name: `${which} scene voiceover`, scene: which, field: "voiceover", apply: (p, r) => { sceneAt(p, which).voiceover = fresh(r); } },
    { name: `${which} scene on-screen text`, scene: which, field: "on_screen_text", apply: (p, r) => { sceneAt(p, which).on_screen_text = fresh(r); } },
    { name: `${which} scene claims`, scene: which, field: "claims", apply: (p, r) => { sceneAt(p, which).claims = [...sceneAt(p, which).claims, fresh(r)]; } },
  ]),
];

// ---- the rule, written out independently of the engine: which fields each tested variable may touch ----

const SPEC: Record<TestedVariable, { plan: string[]; first?: string[]; any?: string[] }> = {
  hook: { plan: ["hook", "hook_id"], first: ["voiceover", "on_screen_text"] },
  angle: { plan: ["angle", "hook"], any: ["voiceover", "on_screen_text", "claims"] },
  offer: { plan: [], any: ["voiceover", "on_screen_text", "claims"] },
  cta: { plan: ["cta.text", "cta.url"] },
  visual_style: { plan: [], any: ["visual_prompt", "visual_source"] },
};
function allowedBySpec(variable: TestedVariable, m: Mutation): boolean {
  const s = SPEC[variable];
  if (m.plan) return s.plan.includes(m.field);
  return !!(s.any?.includes(m.field) || (m.scene === "first" && s.first?.includes(m.field)));
}

await test("every field of a plan and of a scene is covered by the diff engine, so adding a field cannot let a change slip through unseen", () => {
  const planKeys = Object.keys(ScenePlan.shape).filter((k) => k !== "variant"); // `variant` is attached by the server after the check
  const sceneKeys = Object.keys(Scene.shape);
  const covered = new Set(MUTATIONS.filter((m) => m.plan).map((m) => m.field.split(".")[0]));
  for (const k of ["schema_version"]) covered.add(k); // a literal: it cannot be changed to another valid value
  covered.add("scenes");
  for (const k of planKeys) assert.ok(covered.has(k), `plan field "${k}" has no mutation in this test. Add one, make sure variants/diff.ts flatten() includes it, and decide which tested variables may change it (SPEC above).`);
  const sceneCovered = new Set(MUTATIONS.filter((m) => m.scene).map((m) => m.field));
  sceneCovered.add("id"); // ids are covered by the reorder and add-a-scene mutations
  for (const k of sceneKeys) assert.ok(sceneCovered.has(k), `scene field "${k}" has no mutation in this test. Add one, make sure variants/diff.ts flatten() includes it, and decide which tested variables may change it.`);
  // and each mutation really shows up in the diff
  const rand = rng(5);
  for (const m of MUTATIONS) {
    const base = randomPlan(rand);
    const changed = structuredClone(base);
    m.apply(changed, rand);
    assert.ok(diffPlans(base, changed).length > 0, `changing "${m.name}" is invisible to the diff engine`);
  }
});

await test("property: across thousands of random plans and changes, a variant is accepted exactly when every change is one its tested variable allows", () => {
  const rand = rng(2026);
  let accepted = 0;
  let rejected = 0;
  for (let i = 0; i < 4000; i++) {
    const base = randomPlan(rand);
    const variable = TESTED_VARIABLES[Math.floor(rand() * TESTED_VARIABLES.length)];
    // Each change at most once: applying the same swap or toggle twice would undo itself and leave no change at all.
    const picks = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => MUTATIONS[Math.floor(rand() * MUTATIONS.length)]))];
    const variant = structuredClone(base);
    for (const m of picks) m.apply(variant, rand);
    const onlyIds = picks.every((m) => m.field === "hook_id");
    const expectOk = !onlyIds && picks.every((m) => allowedBySpec(variable, m));
    const verdict = checkVariant(base, variant, variable, 0);
    if (verdict.ok !== expectOk) assert.fail(`${variable} with [${picks.map((m) => m.name).join("; ")}]: engine said ${verdict.ok}, the rule says ${expectOk}${verdict.ok ? "" : ` (${verdict.reason})`}`);
    if (verdict.ok) {
      accepted++;
      // whatever was accepted differs only within the allowed fields
      for (const d of verdict.diff) {
        const allowedPath = picks.some((m) => allowedBySpec(variable, m)) && d.path;
        assert.ok(allowedPath, "an accepted variant's stored diff lists only allowed paths");
      }
    } else rejected++;
  }
  assert.ok(accepted > 300 && rejected > 300, `the test exercised both outcomes (accepted ${accepted}, rejected ${rejected})`);
});

await test("property: a change confined to the tested variable is always accepted, and adding any one outside change always rejects it", () => {
  const rand = rng(77);
  for (let i = 0; i < 1500; i++) {
    const base = randomPlan(rand);
    const variable = TESTED_VARIABLES[Math.floor(rand() * TESTED_VARIABLES.length)];
    const inside = MUTATIONS.filter((m) => allowedBySpec(variable, m) && m.field !== "hook_id");
    const outside = MUTATIONS.filter((m) => !allowedBySpec(variable, m));
    const ok = structuredClone(base);
    inside[Math.floor(rand() * inside.length)].apply(ok, rand);
    assert.equal(checkVariant(base, ok, variable, 0).ok, true, `${variable}: a change inside its fields was refused`);
    const leaked = structuredClone(ok);
    outside[Math.floor(rand() * outside.length)].apply(leaked, rand);
    const v = checkVariant(base, leaked, variable, 0);
    assert.equal(v.ok, false, `${variable}: an outside change slipped through`);
    if (!v.ok) assert.ok(v.offending.length > 0, "and the offending paths are named");
  }
});

await test("the server-attached variant record, and a changed scene id, cannot be used to smuggle a difference", () => {
  const rand = rng(9);
  for (let i = 0; i < 200; i++) {
    const base = randomPlan(rand);
    const variant = structuredClone(base);
    variant.hook = fresh(rand);
    variant.variant = { tested_variable: "cta", base_ad_id: "ad_elsewhere", diff: [] }; // metadata is ignored by the comparison
    assert.equal(checkVariant(base, variant, "hook", 0).ok, true);
    const renamed = structuredClone(base);
    renamed.scenes[0].id = "s1-renamed";
    assert.equal(checkVariant(base, renamed, "hook", 0).ok, false, "renaming a scene changes the plan, whatever else is allowed");
    const weird = structuredClone(base);
    weird.scenes[0].id = "s1; DROP";
    assert.equal(checkVariant(base, weird, "hook", 0).ok, false, "unsafe scene ids are refused outright");
  }
});

console.log(`diff properties: ${n} tests passed`);
process.exit(0);
