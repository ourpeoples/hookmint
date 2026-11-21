import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fullAccess } from "../src/core/context.js";
import { createApp } from "../src/server/app.js";
import { auditOf, verifyAudit } from "./inspect.js";
import { connect, key, newReadyAd, setup, waitForStatus } from "./helpers.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

type Call = Awaited<ReturnType<typeof connect>>["call"];
/** A date `ago` days before today, so tests never fall outside the "not older than two years, not in the future" rule. */
const d = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
const days = (count: number, daily: { impressions: number; clicks: number; conversions?: number; spend?: number }, last = 1) =>
  Array.from({ length: count }, (_, i) => ({ date: d(last + count - 1 - i), impressions: daily.impressions, clicks: daily.clicks, conversions: daily.conversions ?? 0, spend: daily.spend ?? 10 }));

async function finish(call: Call, id: string) {
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  const r = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.equal(r.isError, false, r.text);
  await waitForStatus(call, id, "completed", 8000);
}

/** A brand with a finished base ad and two finished hook variants, ready to be launched. */
async function completedGroup(call: Call) {
  const kit = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  const base = await newReadyAd(call, { brand_kit_id: kit });
  const v = await call("create_variants", { job_id: base, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.equal(v.isError, false, v.text);
  const variants = (v.json.variants as { job_id: string }[]).map((x) => x.job_id);
  for (const id of [base, ...variants]) await finish(call, id);
  return { kit, base, variants, group: v.json.variant_group_id as string };
}

async function launch(call: Call, adId: string, platformAdId: string, launch_mode = "platform_experiment") {
  const r = await call("link_ad", { job_id: adId, platform: "meta", platform_ad_id: platformAdId, launch_mode, idempotency_key: key() });
  assert.equal(r.isError, false, r.text);
  return r.json.link_id as string;
}
const record = (call: Call, link_id: string, rows: ReturnType<typeof days>, extra: Record<string, unknown> = {}) =>
  call("record_performance", { link_id, currency: "USD", attribution_window: "7d_click", rows, idempotency_key: key(), ...extra });

const { service, stubs, ctx } = await setup({}, {}, 5000);
const { call } = await connect(service, ctx);
const g = await completedGroup(call);
const [base, v1, v2] = [g.base, g.variants[0], g.variants[1]];

await test("link_ad: only finished ads, one live ad belongs to one Hookmint ad, replays are safe, and the launch mode sets the evidence label", async () => {
  const fresh = await newReadyAd(call);
  const early = await call("link_ad", { job_id: fresh, platform: "meta", platform_ad_id: "999", launch_mode: "separate", idempotency_key: key() });
  assert.equal(early.isError, true);
  assert.match(early.text, /\[conflict\].*once its video is made/);
  const k = key();
  const args = { job_id: base, platform: "meta", platform_ad_id: "ad-base-1", launch_mode: "platform_experiment", aspect_ratio: "9:16", idempotency_key: k };
  const first = await call("link_ad", args);
  assert.equal(first.isError, false, first.text);
  assert.match(first.json.link_id, /^lk_[0-9a-f]{8}$/);
  assert.equal(first.json.evidence, "causal");
  const again = await call("link_ad", args);
  assert.equal(again.json.link_id, first.json.link_id, "a replay returns the same link");
  const different = await call("link_ad", { ...args, platform_ad_id: "other" });
  assert.match(different.text, /\[conflict\].*idempotency_key was already used for a different request/);
  const dup = await call("link_ad", { job_id: v1, platform: "meta", platform_ad_id: "ad-base-1", launch_mode: "platform_experiment", idempotency_key: key() });
  assert.match(dup.text, /\[conflict\].*already linked/);
  const sep = await call("link_ad", { job_id: fresh, platform: "tiktok", platform_ad_id: "x", launch_mode: "separate", idempotency_key: key() });
  assert.equal(sep.isError, true, "still not finished");
  const bad = await call("link_ad", { job_id: base, platform: "meta", platform_ad_id: "has spaces!", launch_mode: "same_ad_set", idempotency_key: key() });
  assert.equal(bad.isError, true);
  const other = await (await connect(service, fullAccess("acct_b"))).call("link_ad", { job_id: base, platform: "meta", platform_ad_id: "stolen", launch_mode: "same_ad_set", idempotency_key: key() });
  assert.match(other.text, /\[not_found\]/, "another account cannot link your ad");
  const sepLink = await call("link_ad", { job_id: base, platform: "google", platform_ad_id: "sep-1", launch_mode: "separate", idempotency_key: key() });
  assert.equal(sepLink.json.evidence, "observational");
});

await test("link_ad: an ad can have at most ten live ads", async () => {
  const kit = (await call("create_brand_kit", { name: "Many" })).json.brand_kit_id as string;
  const ad = await newReadyAd(call, { brand_kit_id: kit });
  await finish(call, ad);
  for (let i = 0; i < 10; i++) await launch(call, ad, `many-${i}`);
  const eleventh = await call("link_ad", { job_id: ad, platform: "meta", platform_ad_id: "many-10", launch_mode: "separate", idempotency_key: key() });
  assert.match(eleventh.text, /\[rate_limited\].*at most 10/);
});

const linkBase = await launch(call, v1, "ad-v1-a"); // v1 first, so `base` keeps its earlier separate links out of this test
void linkBase;

await test("record_performance: rows are checked before anything is stored", async () => {
  const link = await launch(call, v2, "ad-v2-a");
  const rows = days(3, { impressions: 1000, clicks: 30 });
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["clicks above impressions", { rows: [{ date: d(2), impressions: 100, clicks: 101 }] }, /clicks cannot be more than impressions/],
    ["conversions above impressions", { rows: [{ date: d(2), impressions: 100, clicks: 5, conversions: 101 }] }, /conversions cannot be more than impressions/],
    ["a future date", { rows: [{ date: d(-5), impressions: 100, clicks: 5 }] }, /in the future/],
    ["an old date", { rows: [{ date: "2019-01-01", impressions: 100, clicks: 5 }] }, /more than two years ago/],
    ["an impossible date", { rows: [{ date: "2026-02-30", impressions: 100, clicks: 5 }] }, /not a real date/],
    ["a duplicated day", { rows: [rows[0], { ...rows[0], clicks: 1 }] }, /appears twice/],
    ["a negative count", { rows: [{ date: d(2), impressions: -1, clicks: 0 }] }, /too_small|>=0|at least 0|Too small/i],
    ["a fractional count", { rows: [{ date: d(2), impressions: 10.5, clicks: 0 }] }, /int|integer/i],
    ["a bad currency", { currency: "dollars", rows }, /three-letter code/],
    ["a bad attribution window", { attribution_window: "7 days!", rows }, /attribution_window/],
  ];
  for (const [what, extra, re] of cases) {
    const r = await record(call, link, rows, extra);
    assert.equal(r.isError, true, `${what} should be refused`);
    assert.match(r.text, re, what);
  }
  assert.equal((await record(call, link, [])).isError, true, "no rows");
  assert.equal((await record(call, link, Array.from({ length: 101 }, (_, i) => ({ date: d(200 - i), impressions: 10, clicks: 1, conversions: 0, spend: 0 })))).isError, true, "more than 100 rows");
  assert.match((await record(call, "lk_nothere", rows)).text, /\[not_found\]/);
  assert.match((await (await connect(service, fullAccess("acct_b"))).call("record_performance", { link_id: link, currency: "USD", rows, idempotency_key: key() })).text, /\[not_found\]/, "another account's link is invisible");
});

await test("record_performance: replays record once, corrections keep history and the newest wins, and the audit chain stays intact", async () => {
  const kit = (await call("create_brand_kit", { name: "Corrections" })).json.brand_kit_id as string;
  const ad = await newReadyAd(call, { brand_kit_id: kit });
  await finish(call, ad);
  const link = await launch(call, ad, "corr-1");
  const k = key();
  const rows = days(3, { impressions: 1000, clicks: 20 });
  const a = await call("record_performance", { link_id: link, currency: "USD", rows, idempotency_key: k });
  assert.equal(a.isError, false, a.text);
  assert.deepEqual([a.json.days_recorded, a.json.corrected_days], [3, 0]);
  const b = await call("record_performance", { link_id: link, currency: "USD", rows, idempotency_key: k });
  assert.deepEqual(b.json, a.json, "the same request returns the same answer");
  assert.match((await call("record_performance", { link_id: link, currency: "USD", rows: days(2, { impressions: 5, clicks: 1 }), idempotency_key: k })).text, /idempotency_key was already used/);
  const stored = await service.store.tx(ctx.accountId, (t) => t.snapshotsForLinks([link]));
  assert.equal(stored.length, 3, "the replay added nothing");
  const fix = await call("record_performance", { link_id: link, currency: "USD", rows: [{ ...rows[0], clicks: 99 }], idempotency_key: key() });
  assert.deepEqual([fix.json.days_recorded, fix.json.corrected_days], [1, 1]);
  const after = await service.store.tx(ctx.accountId, (t) => t.snapshotsForLinks([link]));
  assert.equal(after.length, 4, "the old row is kept");
  assert.equal(after.filter((r) => r.date === rows[0].date).map((r) => r.clicks).join(), "20,99", "both revisions exist, oldest first");
  assert.equal(await verifyAudit(service, ctx.accountId), true);
  assert.ok((await auditOf(service)).some((e) => e.action === "performance.record"));
});

await test("scopes: recording needs insights:write, reading needs insights:read, linking needs ads:create", async () => {
  const mk = (...scopes: string[]) => ({ accountId: ctx.accountId, scopes: new Set(scopes) });
  const reader = await connect(service, mk("insights:read", "ads:read"));
  const link = (await service.store.tx(ctx.accountId, (t) => t.linksForAds([v1])))[0].id;
  assert.match((await reader.call("record_performance", { link_id: link, currency: "USD", rows: days(1, { impressions: 10, clicks: 1 }), idempotency_key: key() })).text, /Missing required scope "insights:write"/);
  assert.match((await reader.call("link_ad", { job_id: v1, platform: "meta", platform_ad_id: "scope-test", launch_mode: "separate", idempotency_key: key() })).text, /Missing required scope "ads:create"/);
  assert.equal((await reader.call("plan_test", { baseline_rate: 0.02, relative_lift: 0.2, variants: 2 })).isError, false);
  const writer = await connect(service, mk("insights:write", "ads:read"));
  assert.match((await writer.call("get_insights", { brand_kit_id: g.kit })).text, /Missing required scope "insights:read"/);
  assert.match((await writer.call("get_performance", { variant_group_id: g.group })).text, /Missing required scope "insights:read"/);
});

await test("get_performance: a real winner, with intervals, a corrected p-value and a causal label; the other variants are compared on the same days", async () => {
  const kit = (await call("create_brand_kit", { name: "Winners" })).json.brand_kit_id as string;
  const w = await completedGroup(call);
  void kit;
  const lb = await launch(call, w.base, "w-base");
  const l1 = await launch(call, w.variants[0], "w-v1");
  const l2 = await launch(call, w.variants[1], "w-v2");
  assert.equal((await record(call, lb, days(7, { impressions: 1000, clicks: 30 }))).isError, false);       // 3.0%
  assert.equal((await record(call, l1, days(7, { impressions: 1000, clicks: 60 }))).isError, false);       // 6.0%
  assert.equal((await record(call, l2, days(7, { impressions: 1000, clicks: 31 }))).isError, false);       // 3.1%
  const r = await call("get_performance", { variant_group_id: w.group });
  assert.equal(r.isError, false, r.text);
  const rep = r.json.report;
  assert.equal(rep.evidence, "causal");
  assert.equal(rep.tested_variable, "hook");
  assert.equal(rep.window.days, 7);
  assert.equal(rep.verdicts.ctr.status, "winner");
  assert.equal(rep.verdicts.ctr.winner_ad_id, w.variants[0]);
  assert.equal(rep.verdicts.cvr.status, "insufficient_data");
  const win = rep.variants.find((x: { ad_id: string }) => x.ad_id === w.variants[0]);
  assert.ok(Math.abs(win.ctr.rate - 0.06) < 1e-12 && win.ctr.interval.low < 0.06 && win.ctr.interval.high > 0.06);
  assert.ok(win.vs_base.ctr.ratio > 1.9 && win.vs_base.ctr.interval.low > 1 && win.vs_base.ctr.p_adjusted < 0.05);
  assert.equal(r.json.links.length, 3);
  assert.equal(r.json.insights.length, 1);
  assert.match(r.json.insights[0].statement, /^In a controlled test: for "hook", ".+" had a higher click-through rate than/);
  assert.equal(r.json.insights[0].usable_for_generation, true);
  // the same through the brand-wide views
  const ins = (await call("get_insights", { brand_kit_id: w.kit })).json;
  assert.equal(ins.status, "ok");
  assert.equal(ins.groups_with_a_clear_winner, 1);
  assert.equal(ins.insights[0].winning_value, r.json.insights[0].winning_value);
  const summary = (await call("get_performance", { brand_kit_id: w.kit })).json;
  assert.equal(summary.groups[0].verdicts.ctr, "winner");
  // a narrower date range can take a verdict away: three days is 3000 impressions each, still enough, but one day is not
  const oneDay = (await call("get_performance", { variant_group_id: w.group, from: d(1), to: d(1) })).json.report;
  assert.equal(oneDay.verdicts.ctr.status, "winner" , "1000 impressions and 30+ clicks per variant is exactly enough");
  const none = (await call("get_performance", { variant_group_id: w.group, from: d(400), to: d(390) })).json.report;
  assert.equal(none.window, null);
  assert.equal(none.verdicts.ctr.status, "insufficient_data");
  // a correction can overturn it
  const fix = await record(call, l1, days(7, { impressions: 1000, clicks: 31 }));
  assert.deepEqual([fix.json.days_recorded, fix.json.corrected_days], [7, 7]);
  const after = (await call("get_performance", { variant_group_id: w.group })).json;
  assert.equal(after.report.verdicts.ctr.status, "no_clear_winner", "the corrected numbers show no difference");
  assert.equal(after.insights.length, 0);
  assert.equal((await call("get_insights", { brand_kit_id: w.kit })).json.status, "insufficient_data");
});

await test("get_performance: a variant launched separately makes the whole result observational and unusable for generation", async () => {
  const w = await completedGroup(call);
  const lb = await launch(call, w.base, "o-base", "separate");
  const l1 = await launch(call, w.variants[0], "o-v1", "platform_experiment");
  const l2 = await launch(call, w.variants[1], "o-v2", "platform_experiment");
  for (const [l, clicks] of [[lb, 30], [l1, 60], [l2, 31]] as const) await record(call, l, days(7, { impressions: 1000, clicks }));
  const r = (await call("get_performance", { variant_group_id: w.group })).json;
  assert.equal(r.report.evidence, "observational");
  assert.ok(r.report.warnings.some((x: string) => /launched separately/.test(x)));
  assert.equal(r.insights[0].usable_for_generation, false);
  assert.match(r.insights[0].statement, /^Observed, not controlled:/);
});

await test("get_performance: variants measured differently are not compared, and a missing or ambiguous target is refused", async () => {
  const w = await completedGroup(call);
  const lb = await launch(call, w.base, "m-base");
  const l1 = await launch(call, w.variants[0], "m-v1");
  await record(call, lb, days(7, { impressions: 1000, clicks: 30 }));
  await record(call, l1, days(7, { impressions: 1000, clicks: 80 }), { currency: "EUR", attribution_window: "1d_click" });
  const r = (await call("get_performance", { variant_group_id: w.group })).json.report;
  assert.equal(r.comparable, false);
  assert.equal(r.verdicts.ctr.status, "insufficient_data");
  assert.ok(r.warnings.some((x: string) => /different currencies/.test(x)) && r.warnings.some((x: string) => /different attribution windows/.test(x)));
  assert.match((await call("get_performance", {})).text, /either variant_group_id or brand_kit_id/);
  assert.match((await call("get_performance", { variant_group_id: w.group, brand_kit_id: w.kit })).text, /not both/);
  assert.match((await call("get_performance", { variant_group_id: w.group, from: "yesterday" })).text, /not a real date/);
  assert.match((await call("get_performance", { variant_group_id: w.group, from: d(1), to: d(5) })).text, /from must not be after to/);
  assert.match((await call("get_performance", { variant_group_id: "vg_missing" })).text, /\[not_found\]/);
  assert.match((await call("get_insights", { brand_kit_id: "bk_missing" })).text, /\[not_found\]/);
  const other = await connect(service, fullAccess("acct_b"));
  assert.match((await other.call("get_performance", { variant_group_id: w.group })).text, /\[not_found\]/, "another account cannot read these results");
  assert.match((await other.call("get_insights", { brand_kit_id: w.kit })).text, /\[not_found\]/);
});

await test("get_insights: says so plainly when there is nothing to conclude, with or without tests", async () => {
  const empty = (await call("create_brand_kit", { name: "Nothing yet" })).json.brand_kit_id as string;
  const none = (await call("get_insights", { brand_kit_id: empty })).json;
  assert.equal(none.status, "insufficient_data");
  assert.deepEqual(none.insights, []);
  assert.match(none.message, /No variant tests yet/);
  assert.match((await call("get_insights", { brand_kit_id: g.kit })).json.message, /No test has a clear winner yet/);
});

await test("plan_test: sample sizes and days, with the assumptions written out, and nonsense refused", async () => {
  const r = (await call("plan_test", { baseline_rate: 0.05, relative_lift: 0.2, variants: 2, expected_daily_impressions_per_variant: 1000 })).json;
  assert.ok(r.per_variant > 8000 && r.per_variant < 8400);
  assert.equal(r.total, r.per_variant * 2);
  assert.equal(r.days, Math.ceil(r.per_variant / 1000));
  assert.match(r.assumptions, /5% significance, 80% power/);
  assert.match(r.assumptions, /20% relative change from a 5% rate/);
  const four = (await call("plan_test", { baseline_rate: 0.05, relative_lift: 0.2, variants: 4 })).json;
  assert.ok(four.per_variant > r.per_variant && four.days === null);
  for (const bad of [{ baseline_rate: 0, relative_lift: 0.2, variants: 2 }, { baseline_rate: 0.05, relative_lift: 0, variants: 2 }, { baseline_rate: 0.05, relative_lift: 0.2, variants: 1 }, { baseline_rate: 0.9, relative_lift: 0.5, variants: 2 }]) {
    assert.equal((await call("plan_test", bad)).isError, true, JSON.stringify(bad));
  }
});

await test("closing the loop: a controlled-test winner steers new scripts and variants for that brand, and nothing else does", async () => {
  type Seen = { guidance?: { learnings?: { variable: string; metric: string; winning: string; beaten: string[]; relative_lift_percent: number }[] } };
  const scripts: Seen[] = [];
  const variantInputs: { learnings?: unknown[] }[] = [];
  const realScript = stubs.script.generate.bind(stubs.script);
  const realVariants = stubs.variants.generate.bind(stubs.variants);
  stubs.script.generate = async (input) => { scripts.push(input as Seen); return realScript(input); };
  stubs.variants.generate = async (input) => { variantInputs.push(input); return realVariants(input); };
  try {
    const w = await completedGroup(call);
    const ids = [w.base, ...w.variants];
    const links = [await launch(call, ids[0], "loop-base"), await launch(call, ids[1], "loop-v1"), await launch(call, ids[2], "loop-v2")];
    for (const [l, clicks] of [[links[0], 30], [links[1], 70], [links[2], 31]] as const) await record(call, l, days(7, { impressions: 1000, clicks }));
    const winner = (await call("get_performance", { variant_group_id: w.group })).json.insights[0];
    assert.ok(winner, "the test has a clear winner");

    scripts.length = 0;
    const next = await newReadyAd(call, { brand_kit_id: w.kit });
    assert.ok(next);
    const learned = scripts.at(-1)!.guidance!.learnings!;
    assert.equal(learned.length, 1);
    assert.equal(learned[0].variable, "hook");
    assert.equal(learned[0].metric, "ctr");
    assert.equal(learned[0].winning, winner.winning_value);
    assert.ok(learned[0].beaten.length >= 1 && learned[0].relative_lift_percent > 50);
    assert.deepEqual(Object.keys(learned[0]).sort(), ["beaten", "metric", "relative_lift_percent", "variable", "winning"], "text and the size of the win only: no ids, no counts");

    variantInputs.length = 0;
    const more = await call("create_variants", { job_id: next, count: 1, tested_variable: "cta", idempotency_key: key() });
    assert.equal(more.isError, false, more.text);
    assert.equal((variantInputs.at(-1)!.learnings as unknown[]).length, 1, "variants of that brand get the learning too");

    scripts.length = 0;
    const otherKit = (await call("create_brand_kit", { name: "A different brand" })).json.brand_kit_id as string;
    await newReadyAd(call, { brand_kit_id: otherKit });
    assert.equal(scripts.at(-1)!.guidance, undefined, "another brand's wins are not used");
    await newReadyAd(call);
    assert.equal(scripts.at(-1)!.guidance, undefined, "an ad with no brand gets none");
    const stranger = await connect(service, fullAccess("acct_b"));
    await service.grantCredits("acct_b", 100, "t");
    const kitB = (await stranger.call("create_brand_kit", { name: "B's brand" })).json.brand_kit_id as string;
    await newReadyAd(stranger.call, { brand_kit_id: kitB });
    assert.equal(scripts.at(-1)!.guidance, undefined, "another account never sees these results");

    // A launch that was not a fair comparison does not teach anything.
    const sep = await completedGroup(call);
    const sl = [await launch(call, sep.base, "sep-base", "separate"), await launch(call, sep.variants[0], "sep-v1", "separate"), await launch(call, sep.variants[1], "sep-v2", "separate")];
    for (const [l, clicks] of [[sl[0], 30], [sl[1], 70], [sl[2], 31]] as const) await record(call, l, days(7, { impressions: 1000, clicks }));
    assert.equal((await call("get_performance", { variant_group_id: sep.group })).json.insights.length, 1, "the observational result exists...");
    scripts.length = 0;
    await newReadyAd(call, { brand_kit_id: sep.kit });
    assert.equal(scripts.at(-1)!.guidance, undefined, "...but is not used to steer generation");

    // A result that gets corrected away stops steering at once.
    await record(call, links[1], days(7, { impressions: 1000, clicks: 31 }));
    scripts.length = 0;
    await newReadyAd(call, { brand_kit_id: w.kit });
    assert.equal(scripts.at(-1)!.guidance, undefined, "the corrected data no longer shows a winner, so nothing is carried forward");
  } finally {
    stubs.script.generate = realScript;
    stubs.variants.generate = realVariants;
  }
});

await test("REST: the same operations are available under /v1 with the same rules", async () => {
  const w = await completedGroup(call);
  const server = createApp(service, { apiKeys: new Map([["k", ctx]]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { authorization: "Bearer k", "content-type": "application/json" };
  try {
    const mk = async (ad: string, pid: string) => {
      const r = await fetch(`${base}/v1/ads/${ad}/links`, { method: "POST", headers: { ...h, "idempotency-key": key() }, body: JSON.stringify({ platform: "meta", platform_ad_id: pid, launch_mode: "same_ad_set" }) });
      assert.equal(r.status, 201, await r.clone().text());
      return ((await r.json()) as { link_id: string }).link_id;
    };
    const links = [await mk(w.base, "r-base"), await mk(w.variants[0], "r-v1"), await mk(w.variants[1], "r-v2")];
    const clicks = [30, 70, 31];
    for (const [i, l] of links.entries()) {
      const r = await fetch(`${base}/v1/links/${l}/performance`, { method: "POST", headers: { ...h, "idempotency-key": key() }, body: JSON.stringify({ currency: "USD", attribution_window: "7d_click", rows: days(7, { impressions: 1000, clicks: clicks[i] }) }) });
      assert.equal(r.status, 201, await r.clone().text());
    }
    const perf = await fetch(`${base}/v1/variant-groups/${w.group}/performance`, { headers: h });
    assert.equal(perf.status, 200);
    assert.equal(((await perf.json()) as { report: { verdicts: { ctr: { status: string } } } }).report.verdicts.ctr.status, "winner");
    const ins = await fetch(`${base}/v1/brand-kits/${w.kit}/insights`, { headers: h });
    assert.equal(((await ins.json()) as { status: string }).status, "ok");
    assert.equal((await fetch(`${base}/v1/brand-kits/${w.kit}/performance`, { headers: h })).status, 200);
    const plan = await fetch(`${base}/v1/test-plan?baseline_rate=0.05&relative_lift=0.2&variants=2`, { headers: h });
    assert.equal(plan.status, 200);
    assert.equal((await fetch(`${base}/v1/test-plan?baseline_rate=abc&relative_lift=0.2&variants=2`, { headers: h })).status, 400);
    assert.equal((await fetch(`${base}/v1/ads/${w.base}/links`, { method: "POST", headers: h, body: "{}" })).status, 400, "the idempotency key is required");
    assert.equal((await fetch(`${base}/v1/variant-groups/${w.group}/performance?from=nope`, { headers: h })).status, 400);
    assert.equal((await fetch(`${base}/v1/variant-groups/${w.group}/performance`)).status, 401);
  } finally { server.close(); }
});

await test("get_insights: cross-ad breakdowns by hook type come from recorded results, are observational, and leave the controlled insights and generation alone", async () => {
  const kit = (await call("create_brand_kit", { name: "Breakdown" })).json.brand_kit_id as string;
  const ads: { id: string; type: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const b = await newReadyAd(call, { brand_kit_id: kit });
    const v = await call("create_variants", { job_id: b, count: 1, tested_variable: "hook_type", idempotency_key: key() });
    assert.equal(v.isError, false, v.text);
    const vid = v.json.variants[0].job_id as string;
    await finish(call, b);
    await finish(call, vid);
    ads.push({ id: b, type: "product" }, { id: vid, type: "identity" });
  }
  assert.deepEqual(ads.map((a) => a.type), ["product", "identity", "product", "identity"]);
  let n = 0;
  for (const a of ads) {
    const l = await launch(call, a.id, `bd-${++n}`, "separate");
    const clicks = a.type === "identity" ? 300 : 100;
    assert.equal((await record(call, l, days(2, { impressions: 10_000, clicks }))).isError, false);
  }
  const r = (await call("get_insights", { brand_kit_id: kit })).json;
  assert.ok(r.insights.every((i: { usable_for_generation: boolean }) => i.usable_for_generation === false), "launched separately, so even the per-group results are only observational");
  assert.equal(r.breakdown_method_version, "b1");
  const hook = r.breakdowns.find((b: { dimension: string; within: unknown }) => b.dimension === "hook_type" && b.within === null);
  assert.ok(hook, "a hook_type breakdown exists");
  assert.equal(hook.evidence, "observational");
  assert.equal(hook.leads[0].leading_value, "identity");
  assert.equal(hook.leads[0].usable_for_generation, false);
  assert.match(hook.leads[0].statement, /^Observed, not controlled/);
  assert.equal(r.breakdowns.some((b: { dimension: string }) => b.dimension === "platform"), false, "one platform has nothing to compare with");
  // an observational lead never reaches the script prompt: only a controlled, concluded test does
  const learn = await (service as unknown as { run: (a: string, f: (t: unknown) => Promise<unknown[]>) => Promise<unknown[]> }).run(ctx.accountId, (t) => (service as unknown as { learningsFor: (t: unknown, k: string) => Promise<unknown[]> }).learningsFor(t, kit));
  assert.deepEqual(learn, []);
  const empty = (await call("create_brand_kit", { name: "Nothing yet" })).json.brand_kit_id as string;
  const none = (await call("get_insights", { brand_kit_id: empty })).json;
  assert.deepEqual(none.breakdowns, []);
  assert.match(none.breakdown_message, /No cross-ad patterns yet/);
});

console.log(`results: ${n} tests passed`);
process.exit(0);
