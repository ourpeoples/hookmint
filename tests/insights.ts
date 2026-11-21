import assert from "node:assert/strict";
import { BREAKDOWN_METHOD_VERSION, BREAKDOWN_MIN_ADS, computeBreakdowns, type BreakdownLink } from "../src/insights/breakdown.js";
import { testedValue } from "../src/insights/describe.js";
import { analyzeGroup, insightsFrom, THRESHOLDS, type LaunchMode, type Snapshot, type VariantInput } from "../src/insights/analyze.js";
import { METHOD_VERSION } from "../src/insights/stats.js";

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

const day = (start: string, offset: number) => new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
/** `days` rows starting at `start`, each with the given daily numbers. */
function rows(link: string, start: string, days: number, daily: { impressions: number; clicks: number; conversions?: number; spend?: number }, extra: Partial<Snapshot> = {}) {
  return Array.from({ length: days }, (_, i) => ({ link_id: link, date: day(start, i), spend: daily.spend ?? 10, impressions: daily.impressions, clicks: daily.clicks, conversions: daily.conversions ?? 0, currency: "USD", attribution_window: "7d_click", timezone: "UTC", ...extra }));
}
const variant = (id: string, value: string, rs: VariantInput["rows"], over: Partial<VariantInput> = {}): VariantInput => ({ ad_id: id, is_base: id === "base", value, launch_modes: ["platform_experiment"] as LaunchMode[], rows: rs, ...over });

function rng(seed: number) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

await test("a clear winner: named, with numbers, intervals and a corrected p-value, and an insight whose every figure comes from the data", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "Spring is here", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),   // 3.0%
    variant("v1", "Your weekend is worth more", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 45 })), // 4.5%
  ]);
  assert.equal(rep.method_version, METHOD_VERSION);
  assert.equal(rep.evidence, "causal");
  assert.equal(rep.comparable, true);
  assert.deepEqual(rep.window, { start: "2026-05-01", end: "2026-05-07", days: 7 });
  assert.equal(rep.verdicts.ctr.status, "winner");
  assert.equal(rep.verdicts.ctr.winner_ad_id, "v1");
  const v1 = rep.variants.find((v) => v.ad_id === "v1")!;
  assert.ok(Math.abs(v1.ctr.rate! - 0.045) < 1e-12);
  assert.ok(v1.ctr.interval!.low < 0.045 && v1.ctr.interval!.high > 0.045);
  assert.ok(Math.abs(v1.vs_base!.ctr!.ratio - 1.5) < 1e-9);
  assert.ok(v1.vs_base!.ctr!.interval.low > 1, "the interval for the lift excludes no change");
  assert.ok(v1.vs_base!.ctr!.p_adjusted < 0.05);
  assert.equal(rep.variants.find((v) => v.ad_id === "base")!.vs_base, null);
  assert.equal(rep.verdicts.cvr.status, "insufficient_data", "no conversions recorded, so conversion rate says nothing");
  const ins = insightsFrom("vg_1", rep);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].metric, "ctr");
  assert.equal(ins[0].winning_value, "Your weekend is worth more");
  assert.deepEqual(ins[0].beaten_values, ["Spring is here"]);
  assert.equal(ins[0].usable_for_generation, true);
  assert.match(ins[0].statement, /^In a controlled test: for "hook", "Your weekend is worth more" had a higher click-through rate than "Spring is here" \(4\.5% against 3%, \+50% relative, 95% interval /);
  assert.match(ins[0].statement, /suggests, and does not prove/);
  assert.equal(ins[0].sample_size.impressions_per_variant_min, 7000);
  assert.deepEqual(ins[0].metric_definition, { metric: "ctr", formula: "clicks / impressions", attribution_window: "7d_click", currency: "USD", timezone: "UTC" }, "what winning meant is recorded with the insight");
  assert.deepEqual(rep.measurement, { attribution_window: "7d_click", currency: "USD", timezone: "UTC" });
  assert.match(ins[0].id, /^ins_[0-9a-f]{12}$/);
  assert.equal(insightsFrom("vg_1", rep)[0].id, ins[0].id, "the same data gives the same id");
  assert.notEqual(insightsFrom("vg_2", rep)[0].id, ins[0].id, "another group gives another id");
});

await test("too little data: no verdict, and it says exactly how much more each variant needs", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "A", rows("l1", "2026-05-01", 2, { impressions: 300, clicks: 9 })),   // 600 impressions, 18 clicks
    variant("v1", "B", rows("l2", "2026-05-01", 2, { impressions: 400, clicks: 4 })),     // 800 impressions, 8 clicks
  ]);
  assert.equal(rep.verdicts.ctr.status, "insufficient_data");
  assert.equal(rep.verdicts.ctr.winner_ad_id, null);
  assert.deepEqual(rep.verdicts.ctr.shortfalls, [{ ad_id: "base", need: "400 more impressions and 2 more clicks" }, { ad_id: "v1", need: "200 more impressions and 12 more clicks" }]);
  assert.deepEqual(insightsFrom("g", rep), [], "no verdict, no insight");
  // Still shows what was observed, with intervals, so the user can see the picture.
  assert.ok(rep.variants[0].ctr.interval!.high - rep.variants[0].ctr.interval!.low > 0.02, "a wide interval, honestly");
  assert.equal(THRESHOLDS.ctr.minTrials, 1000);
});

await test("a real-looking difference that is not enough: 'no clear winner', never a coin-flip pick", () => {
  const rep = analyzeGroup("cta", [
    variant("base", "A", rows("l1", "2026-05-01", 7, { impressions: 400, clicks: 12 })),   // 2800 impressions, 3.0%
    variant("v1", "B", rows("l2", "2026-05-01", 7, { impressions: 400, clicks: 13 })),     // 3.25%
  ]);
  assert.equal(rep.verdicts.ctr.status, "no_clear_winner");
  assert.equal(rep.verdicts.ctr.winner_ad_id, null);
  assert.deepEqual(insightsFrom("g", rep), []);
});

await test("three variants: both beating the base is not a winner unless one beats the other, and shrunk rates appear", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "Base", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),    // 3.0%
    variant("a", "A", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 46 })),          // 4.6%
    variant("b", "B", rows("l3", "2026-05-01", 7, { impressions: 1000, clicks: 45 })),          // 4.5%
  ]);
  assert.equal(rep.verdicts.ctr.status, "no_clear_winner", "A and B cannot be told apart");
  assert.equal(rep.verdicts.ctr.comparisons.length, 3, "every pair is compared");
  rep.verdicts.ctr.comparisons.forEach((c) => assert.ok(c.p_adjusted >= c.p));
  for (const v of rep.variants) assert.ok(v.ctr.shrunk_rate !== null, "three or more variants get a shrunk rate");
  const a = rep.variants.find((v) => v.ad_id === "a")!;
  assert.ok(a.vs_base!.ctr!.p_adjusted < 0.05 && rep.variants.find((v) => v.ad_id === "b")!.vs_base!.ctr!.p_adjusted < 0.05, "both clearly beat the base");
  const clear = analyzeGroup("hook", [
    variant("base", "Base", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),
    variant("a", "A", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 60 })),
    variant("b", "B", rows("l3", "2026-05-01", 7, { impressions: 1000, clicks: 40 })),
  ]);
  assert.equal(clear.verdicts.ctr.winner_ad_id, "a");
  const two = analyzeGroup("hook", [variant("base", "B", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })), variant("a", "A", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 60 }))]);
  assert.equal(two.variants[0].ctr.shrunk_rate, null, "two variants: no shrinkage");
});

await test("many variants raise the bar: a gap that looks significant pair by pair is not a win once corrected for fifteen comparisons", () => {
  const six = [
    variant("base", "Base", rows("l0", "2026-05-01", 7, { impressions: 1000, clicks: 36 })),
    variant("a", "A", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 44 })),
    ...[2, 3, 4, 5].map((i) => variant(`v${i}`, `V${i}`, rows(`l${i}`, "2026-05-01", 7, { impressions: 1000, clicks: 36 }))),
  ];
  const rep = analyzeGroup("hook", six);
  const raw = rep.verdicts.ctr.comparisons.filter((c) => c.a === "a" || c.b === "a");
  assert.ok(raw.every((c) => c.p < 0.05), "A against each other variant, taken alone, looks significant");
  assert.ok(raw.every((c) => c.p_adjusted > 0.05), "but not after correcting for all fifteen comparisons");
  assert.equal(rep.verdicts.ctr.status, "no_clear_winner");
  assert.deepEqual(insightsFrom("g", rep), []);
});

await test("a variant that has not run yet is left out and listed, instead of blocking the others", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "Original", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),
    variant("v1", "Launched", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 60 })),
    variant("v2", "Not launched", [], { launch_modes: [] }),
  ]);
  assert.equal(rep.verdicts.ctr.winner_ad_id, "v1");
  assert.ok(rep.warnings.some((w) => /1 variant\(s\) have no results yet and were left out/.test(w)));
  assert.equal(rep.variants.length, 3, "still listed");
  const idle = rep.variants.find((v) => v.ad_id === "v2")!;
  assert.deepEqual([idle.totals.days, idle.ctr.rate, idle.vs_base], [0, null, null]);
  assert.equal(rep.evidence, "causal", "an unlaunched variant does not make the others observational");
  assert.equal(rep.verdicts.ctr.comparisons.length, 1, "only the two launched variants are compared");
  const ins = insightsFrom("g", rep)[0];
  assert.deepEqual(ins.beaten_values, ["Original"], "an unlaunched variant was not beaten");
  assert.equal(ins.sample_size.impressions_per_variant_min, 7000);
  assert.equal(rep.variants.find((v) => v.ad_id === "base")!.ctr.shrunk_rate, null, "two launched variants: no shrinkage");
});

await test("the base can win too: a variant that does worse is reported as a win for the original", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "The original", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 60 })),
    variant("v1", "The new idea", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),
  ]);
  assert.equal(rep.verdicts.ctr.winner_ad_id, "base");
  const ins = insightsFrom("g", rep)[0];
  assert.equal(ins.winning_value, "The original");
  assert.deepEqual(ins.beaten_values, ["The new idea"]);
});

await test("separately launched variants are labelled observational and cannot steer generation", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "A", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 }), { launch_modes: ["separate"] }),
    variant("v1", "B", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 50 }), { launch_modes: ["platform_experiment"] }),
  ]);
  assert.equal(rep.evidence, "observational");
  assert.ok(rep.warnings.some((w) => /launched separately/.test(w)));
  assert.equal(rep.verdicts.ctr.status, "winner", "still reported, but labelled");
  const ins = insightsFrom("g", rep)[0];
  assert.equal(ins.evidence, "observational");
  assert.equal(ins.usable_for_generation, false);
  assert.match(ins.statement, /^Observed, not controlled:/);
  const unlinked = analyzeGroup("hook", [variant("base", "A", [], { launch_modes: [] }), variant("v1", "B", [], { launch_modes: [] })]);
  assert.equal(unlinked.evidence, "observational");
  assert.equal(unlinked.window, null);
});

await test("concurrent days only: days where a variant has no data are left out, and no overlap means no comparison", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "A", rows("l1", "2026-05-01", 10, { impressions: 500, clicks: 15 })),   // May 1-10
    variant("v1", "B", rows("l2", "2026-05-06", 10, { impressions: 500, clicks: 25 })),     // May 6-15
  ]);
  assert.deepEqual(rep.window, { start: "2026-05-06", end: "2026-05-10", days: 5 });
  assert.equal(rep.variants[0].totals.days, 5);
  assert.equal(rep.variants[0].totals.impressions, 2500, "only the shared five days count");
  assert.ok(rep.warnings.some((w) => /10 daily row\(s\) were left out/.test(w)));
  const none = analyzeGroup("hook", [variant("base", "A", rows("l1", "2026-05-01", 3, { impressions: 900, clicks: 30 })), variant("v1", "B", rows("l2", "2026-06-01", 3, { impressions: 900, clicks: 60 }))]);
  assert.equal(none.window, null);
  assert.equal(none.verdicts.ctr.status, "insufficient_data");
  assert.ok(none.warnings.some((w) => /no days in common/.test(w)));
});

await test("a variant live on two platforms has each day's numbers added together", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "A", rows("l1", "2026-05-01", 5, { impressions: 1000, clicks: 30 })),
    variant("v1", "B", [...rows("l2", "2026-05-01", 5, { impressions: 600, clicks: 30 }), ...rows("l3", "2026-05-01", 5, { impressions: 400, clicks: 15 })]),
  ]);
  const v1 = rep.variants[1];
  assert.equal(v1.totals.impressions, 5000);
  assert.equal(v1.totals.clicks, 225);
  assert.equal(v1.totals.days, 5, "five days, not ten");
});

await test("measured differently means not comparable: different currencies or attribution windows block any verdict and say why", () => {
  const rep = analyzeGroup("hook", [
    variant("base", "A", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })),
    variant("v1", "B", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 90 }, { currency: "EUR", attribution_window: "1d_click" })),
  ]);
  assert.equal(rep.comparable, false);
  assert.deepEqual(rep.measurement, { attribution_window: null, currency: null, timezone: "UTC" }, "a disagreement is shown as null, not hidden");
  assert.ok(rep.warnings.some((w) => /different currencies \(USD, EUR\)/.test(w)));
  assert.ok(rep.warnings.some((w) => /different attribution windows/.test(w)));
  assert.equal(rep.verdicts.ctr.status, "insufficient_data");
  assert.deepEqual(insightsFrom("g", rep), []);
  const zones = analyzeGroup("hook", [variant("base", "A", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 })), variant("v1", "B", rows("l2", "2026-05-01", 7, { impressions: 1000, clicks: 60 }, { timezone: "America/New_York" }))]);
  assert.equal(zones.comparable, true, "a time zone difference is a warning, not a block");
  assert.ok(zones.warnings.some((w) => /different time zones/.test(w)));
});

await test("conversion rate has its own thresholds and is judged on clicks; cost per conversion is a labelled point estimate", () => {
  const rep = analyzeGroup("offer", [
    variant("base", "A", rows("l1", "2026-05-01", 10, { impressions: 2000, clicks: 20, conversions: 1, spend: 30 })),   // 200 clicks, 10 conv, 5%
    variant("v1", "B", rows("l2", "2026-05-01", 10, { impressions: 2000, clicks: 20, conversions: 3, spend: 30 })),    // 200 clicks, 30 conv, 15%
  ]);
  assert.equal(rep.verdicts.ctr.status, "no_clear_winner", "same click rate");
  assert.equal(rep.verdicts.cvr.status, "winner");
  assert.equal(rep.verdicts.cvr.winner_ad_id, "v1");
  assert.equal(rep.variants[1].cost_per_conversion.value, 10);
  assert.match(rep.variants[1].cost_per_conversion.note, /point estimate only/i);
  assert.equal(rep.variants[0].cost_per_conversion.value, 30);
  assert.equal(insightsFrom("g", rep).map((i) => i.metric).join(), "cvr");
  const few = analyzeGroup("offer", [variant("base", "A", rows("l1", "2026-05-01", 10, { impressions: 2000, clicks: 20, conversions: 0 })), variant("v1", "B", rows("l2", "2026-05-01", 10, { impressions: 2000, clicks: 20, conversions: 1 }))]);
  assert.equal(few.verdicts.cvr.status, "insufficient_data");
  assert.equal(few.variants[0].cost_per_conversion.value, null);
  assert.match(few.verdicts.cvr.shortfalls[0].need, /10 more conversions/);
});

await test("edge cases: a variant with no impressions, a single variant, and an empty group do not crash or invent anything", () => {
  const zero = analyzeGroup("hook", [variant("base", "A", rows("l1", "2026-05-01", 3, { impressions: 0, clicks: 0 })), variant("v1", "B", rows("l2", "2026-05-01", 3, { impressions: 0, clicks: 0 }))]);
  assert.equal(zero.variants[0].ctr.rate, null);
  assert.equal(zero.variants[0].ctr.interval, null);
  assert.equal(zero.verdicts.ctr.status, "insufficient_data");
  const solo = analyzeGroup("hook", [variant("base", "A", rows("l1", "2026-05-01", 7, { impressions: 1000, clicks: 30 }))]);
  assert.equal(solo.verdicts.ctr.status, "insufficient_data");
  const empty = analyzeGroup("hook", []);
  assert.equal(empty.window, null);
  assert.deepEqual(insightsFrom("g", empty), []);
});

await test("end to end calibration: groups of identical variants almost never produce a winner, and real differences usually do", () => {
  const rand = rng(99);
  const draw = (nTrials: number, p: number) => { let x = 0; for (let i = 0; i < nTrials; i++) if (rand() < p) x++; return x; };
  const group = (rates: number[]) => analyzeGroup("hook", rates.map((p, i) => variant(i === 0 ? "base" : `v${i}`, `V${i}`, [{ link_id: `l${i}`, date: "2026-05-01", spend: 1, impressions: 3000, clicks: draw(3000, p), conversions: 0, currency: "USD", attribution_window: "7d_click", timezone: "UTC" }])));
  let falseWinners = 0;
  const runs = 600;
  for (let r = 0; r < runs; r++) if (group([0.04, 0.04, 0.04]).verdicts.ctr.status === "winner") falseWinners++;
  assert.ok(falseWinners / runs <= 0.06, `${(falseWinners / runs * 100).toFixed(1)}% of identical groups named a winner`);
  let found = 0;
  for (let r = 0; r < runs; r++) {
    const g = group([0.04, 0.04, 0.065]);
    if (g.verdicts.ctr.winner_ad_id === "v2") found++;
  }
  assert.ok(found / runs > 0.7, `a 60% lift was found ${(found / runs * 100).toFixed(0)}% of the time`);
});

await test("hook_type tests are reported by the type, so a winner reads 'identity', not one sentence", () => {
  const plan = (over: Record<string, unknown>) => ({ hook: "A hook line that is quite specific to one ad", ...over }) as never;
  assert.equal(testedValue(plan({ hook_type: "pattern_interrupt" }), "hook_type"), "pattern_interrupt");
  assert.equal(testedValue(plan({}), "hook_type"), "A hook line that is quite specific to one ad", "an unlabelled hook falls back to its words");
});

// ---- cross-ad breakdowns (observational, method b1) ----

const bday = (i: number, impressions: number, clicks: number, conversions = 0, over: Record<string, string> = {}) =>
  ({ date: `2026-05-${String(10 + i).padStart(2, "0")}`, spend: 20, impressions, clicks, conversions, currency: "USD", attribution_window: "7d_click", timezone: "UTC", ...over });
const link = (ad: string, hook_type: string | null, platform: string, rows: ReturnType<typeof bday>[]): BreakdownLink => ({ ad_id: ad, hook_type, link_id: `l_${ad}_${platform}`, platform, rows });

await test("breakdown: a hook type that beats the others across ads is reported as a lead, labelled observational, and never usable for generation", () => {
  const links = [
    link("a1", "identity", "tiktok", [bday(0, 10_000, 300), bday(1, 10_000, 320)]),
    link("a2", "identity", "tiktok", [bday(0, 10_000, 310)]),
    link("a3", "product", "tiktok", [bday(0, 10_000, 100), bday(1, 10_000, 110)]),
    link("a4", "product", "tiktok", [bday(0, 10_000, 105)]),
  ];
  const [b] = computeBreakdowns(links);
  assert.equal(b.dimension, "hook_type");
  assert.equal(b.method_version, BREAKDOWN_METHOD_VERSION);
  assert.equal(b.evidence, "observational");
  assert.equal(b.within, null);
  const lead = b.leads.find((l) => l.metric === "ctr")!;
  assert.equal(lead.leading_value, "identity");
  assert.deepEqual(lead.beaten_values, ["product"]);
  assert.equal(lead.usable_for_generation, false, "only a controlled test may steer generation");
  assert.ok(lead.adjusted_p < 0.05);
  assert.match(lead.statement, /^Observed, not controlled: across your ads, hook type "identity" had a higher click-through rate than "product"/);
  assert.match(lead.statement, /lead to test, not a result/);
  assert.match(lead.suggested_test!, /create_variants.*hook_type/);
  assert.equal(b.rows.find((r) => r.value === "identity")!.ads, 2);
  assert.ok(b.rows.every((r) => r.ctr.interval && r.ctr.interval.low < r.ctr.rate! && r.ctr.rate! < r.ctr.interval.high));
});

await test("breakdown: one ad per group, too little data, alike rates, and mixed measurement all give no lead, and say why", () => {
  const one = computeBreakdowns([link("a1", "identity", "meta", [bday(0, 10_000, 300)]), link("a2", "product", "meta", [bday(0, 10_000, 100)])])[0];
  assert.equal(one.leads.length, 0);
  assert.ok(one.rows.every((r) => r.shortfall?.includes(`at least ${BREAKDOWN_MIN_ADS}`)), "one ad is just that ad");
  const small = computeBreakdowns([link("a1", "identity", "meta", [bday(0, 300, 9)]), link("a2", "identity", "meta", [bday(1, 300, 9)]), link("a3", "product", "meta", [bday(0, 300, 3)]), link("a4", "product", "meta", [bday(1, 300, 3)])])[0];
  assert.equal(small.leads.length, 0);
  assert.match(small.rows[0].shortfall!, /Not enough data/);
  const alike = computeBreakdowns([link("a1", "identity", "meta", [bday(0, 10_000, 200)]), link("a2", "identity", "meta", [bday(1, 10_000, 205)]), link("a3", "product", "meta", [bday(0, 10_000, 202)]), link("a4", "product", "meta", [bday(1, 10_000, 198)])])[0];
  assert.equal(alike.leads.length, 0, "no clear difference, no lead");
  const mixed = computeBreakdowns([
    link("a1", "identity", "meta", [bday(0, 10_000, 300)]), link("a2", "identity", "meta", [bday(1, 10_000, 300)]),
    link("a3", "product", "meta", [bday(0, 10_000, 100, 0, { attribution_window: "1d_click" })]), link("a4", "product", "meta", [bday(1, 10_000, 100, 0, { attribution_window: "1d_click" })]),
  ])[0];
  assert.equal(mixed.comparable, false);
  assert.equal(mixed.leads.length, 0);
  assert.match(mixed.warnings.join(" "), /different attribution windows/);
  assert.equal(computeBreakdowns([link("a1", "identity", "meta", [bday(0, 10_000, 300)])]).length, 0, "a single group has nothing to compare");
});

await test("breakdown: the leader must beat every other group, hook types are compared inside each platform, and ads with no label are counted apart", () => {
  const three = [
    link("a1", "identity", "meta", [bday(0, 20_000, 600)]), link("a2", "identity", "meta", [bday(1, 20_000, 620)]),
    link("a3", "product", "meta", [bday(0, 20_000, 200)]), link("a4", "product", "meta", [bday(1, 20_000, 210)]),
    link("a5", "trend", "meta", [bday(0, 20_000, 590)]), link("a6", "trend", "meta", [bday(1, 20_000, 610)]),
  ];
  assert.equal(computeBreakdowns(three)[0].leads.length, 0, "identity does not clearly beat trend, so there is no lead at all");
  const split = [
    link("a1", "identity", "tiktok", [bday(0, 10_000, 300)]), link("a2", "identity", "tiktok", [bday(1, 10_000, 300)]),
    link("a3", "product", "tiktok", [bday(0, 10_000, 100)]), link("a4", "product", "tiktok", [bday(1, 10_000, 100)]),
    link("a5", "identity", "meta", [bday(0, 10_000, 120)]),
    link("a6", "identity", "meta", [bday(1, 10_000, 125)]),
    link("a7", "product", "meta", [bday(0, 10_000, 118)]), link("a8", "product", "meta", [bday(1, 10_000, 122)]),
    link("a9", null, "meta", [bday(0, 10_000, 500)]),
  ];
  const all = computeBreakdowns(split);
  assert.deepEqual(all.map((b) => `${b.dimension}:${b.within?.platform ?? "all"}`), ["platform:all", "hook_type:all", "hook_type:meta", "hook_type:tiktok"]);
  const meta = all.find((b) => b.within?.platform === "meta")!;
  const tiktok = all.find((b) => b.within?.platform === "tiktok")!;
  assert.equal(meta.leads.length, 0, "on meta the two hook types look alike");
  assert.equal(tiktok.leads[0].leading_value, "identity");
  assert.match(tiktok.leads[0].statement, /across your ads on tiktok/);
  assert.equal(meta.unlabelled_ads, 1, "the ad with no label is counted, not compared");
});

console.log(`insights: ${n} tests passed`);
process.exit(0);
