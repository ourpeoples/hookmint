import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fullAccess } from "../src/core/context.js";
import { AdService } from "../src/core/service.js";
import { ScenePlan } from "../src/core/schemas.js";
import { createStubProviders } from "../src/providers/stub.js";
import { createApp } from "../src/server/app.js";
import { allowedPaths, checkVariant, diffPlans, TESTED_VARIABLES, textDistance } from "../src/variants/diff.js";
import { connect, key, newReadyAd, setup, sleep, waitForStatus, TEST_LIMITS } from "./helpers.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok", name);
};

const base = (): ScenePlan => ({
  schema_version: "1.1",
  template: { id: "t", version: "1" },
  hook: "Spring clean, done for you",
  hook_id: "h1",
  angle: "problem-solution",
  variant_group_id: "vg1",
  cta: { text: "Book today" },
  aspect_ratios: ["9:16"],
  scenes: [
    { id: "s1", duration_s: 5, visual_prompt: "kitchen wide shot", visual_source: "stock", voiceover: "Your kitchen needs a reset.", on_screen_text: "Spring special", claims: [] },
    { id: "s2", duration_s: 5, visual_prompt: "crew arriving", visual_source: "stock", voiceover: "We bring everything.", claims: [] },
  ],
});
const edit = (f: (p: ScenePlan) => void) => {
  const p = base();
  f(p);
  return p;
};
const paths = (b: ScenePlan, v: ScenePlan) => diffPlans(b, v).map((d) => d.path);

// ---------- diff engine ----------

await test("diff: reports exactly the changed paths, keyed by scene id", async () => {
  const v = edit((p) => {
    p.hook = "Your weekend back";
    p.scenes[1].voiceover = "Different words here";
    p.scenes[0].on_screen_text = undefined;
  });
  assert.deepEqual(paths(base(), v), ["hook", "scenes[s1].on_screen_text", "scenes[s2].voiceover"]);
  const d = diffPlans(base(), v).find((x) => x.path === "scenes[s1].on_screen_text")!;
  assert.deepEqual([d.from, d.to], ["Spring special", null]);
  assert.deepEqual(diffPlans(base(), base()), []);
});

await test("diff: each tested variable allows only its own fields", async () => {
  const b = base();
  const ok = (v: (typeof TESTED_VARIABLES)[number], p: string) => allowedPaths(v, b)(p);
  assert.ok(ok("hook", "hook") && ok("hook", "hook_id") && ok("hook", "scenes[s1].voiceover") && ok("hook", "scenes[s1].on_screen_text"));
  assert.ok(!ok("hook", "scenes[s2].voiceover"), "hook may only touch the first scene");
  assert.ok(!ok("hook", "cta.text") && !ok("hook", "angle"));
  assert.ok(ok("angle", "angle") && ok("angle", "hook") && ok("angle", "scenes[s2].claims"));
  assert.ok(!ok("angle", "hook_id") && !ok("angle", "scenes[s1].visual_prompt"));
  assert.ok(ok("offer", "scenes[s2].claims") && !ok("offer", "hook") && !ok("offer", "cta.text"));
  assert.ok(ok("cta", "cta.text") && ok("cta", "cta.url") && !ok("cta", "scenes[s1].voiceover"));
  assert.ok(ok("visual_style", "scenes[s2].visual_prompt") && ok("visual_style", "scenes[s1].visual_source"));
  assert.ok(!ok("visual_style", "scenes[s1].voiceover") && !ok("visual_style", "scenes[s1].duration_s"));
});

await test("checkVariant: accepts a clean variant and returns the computed diff", async () => {
  const v = edit((p) => {
    p.hook = "Your weekend back, starting today";
    p.hook_id = "h2";
    p.scenes[0].voiceover = "Opening line: your weekend back.";
    p.scenes[0].on_screen_text = "Your weekend back";
  });
  const r = checkVariant(base(), v, "hook");
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.diff.map((d) => d.path), ["hook", "hook_id", "scenes[s1].on_screen_text", "scenes[s1].voiceover"]);
});

await test("checkVariant: rejects anything outside the tested variable", async () => {
  const cases: [string, (p: ScenePlan) => void, string][] = [
    ["cta change in a hook test", (p) => { p.hook = "Your weekend back, starting today"; p.cta.text = "Call now"; }, "cta.text"],
    ["duration change", (p) => { p.hook = "Your weekend back, starting today"; p.scenes[0].duration_s = 6; }, "scenes[s1].duration_s"],
    ["aspect ratios", (p) => { p.hook = "Your weekend back, starting today"; p.aspect_ratios = ["1:1"]; }, "aspect_ratios"],
    ["template", (p) => { p.hook = "Your weekend back, starting today"; p.template = { id: "other", version: "2" }; }, "template.id"],
    ["second scene voiceover in a hook test", (p) => { p.hook = "Your weekend back, starting today"; p.scenes[1].voiceover = "Totally new words appear here"; }, "scenes[s2].voiceover"],
    ["scene order", (p) => { p.hook = "Your weekend back, starting today"; p.scenes.reverse(); }, "scenes.order"],
    ["added scene", (p) => { p.hook = "Your weekend back, starting today"; p.scenes.push({ ...p.scenes[0], id: "s3" }); }, "scenes.order"],
    ["visual prompt in a hook test", (p) => { p.hook = "Your weekend back, starting today"; p.scenes[0].visual_prompt = "a completely different kitchen"; }, "scenes[s1].visual_prompt"],
  ];
  for (const [name, f, expectPath] of cases) {
    const r = checkVariant(base(), edit(f), "hook");
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.offending.includes(expectPath), `${name}: offending was ${r.offending}`);
  }
  // The same change is fine when it IS the tested variable.
  assert.equal(checkVariant(base(), edit((p) => { p.cta.text = "Get a free quote today"; }), "cta").ok, true);
  assert.equal(checkVariant(base(), edit((p) => { p.hook = "Your weekend back, starting today"; }), "cta").ok, false);
});

await test("checkVariant: rejects identical, near-copy, and unsafe scene ids", async () => {
  const same = checkVariant(base(), base(), "hook");
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.reason, /identical/);
  const near = checkVariant(base(), edit((p) => { p.hook = "Spring clean, done for you!"; }), "hook");
  assert.equal(near.ok, false);
  if (!near.ok) assert.match(near.reason, /too similar to the base/);
  const odd = edit((p) => { p.scenes[0].id = "s1].voiceover"; });
  const bad = checkVariant(odd, edit((p) => { p.scenes[0].id = "s1].voiceover"; p.hook = "Your weekend back, starting today"; }), "hook");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /scene id/);
});

await test("checkVariant: a changed hook_id alone does not make a variant look different", async () => {
  const onlyId = checkVariant(base(), edit((p) => { p.hook_id = "h_totally-new-id-0001"; }), "hook");
  assert.equal(onlyId.ok, false);
  if (!onlyId.ok) assert.match(onlyId.reason, /identical/);
  const nearWithNewId = checkVariant(base(), edit((p) => { p.hook = "Spring clean, done for you!"; p.hook_id = "h_another-random-id-9999"; }), "hook");
  assert.equal(nearWithNewId.ok, false);
  if (!nearWithNewId.ok) assert.match(nearWithNewId.reason, /too similar to the base/);
});

await test("textDistance: 0 for same words, 1 for none shared, order-insensitive", async () => {
  assert.equal(textDistance("a b c", "c b a"), 0);
  assert.equal(textDistance("one two", "three four"), 1);
  assert.equal(textDistance("", ""), 0);
  assert.ok(Math.abs(textDistance("spring clean now", "spring clean today") - 0.5) < 1e-9);
});

// ---------- service and tools ----------

await test("create_variants: new ads, each differing only in the tested variable, base untouched", async () => {
  const { service, stubs, ctx } = setup();
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  const baseStatus = (await call("get_ad_status", { job_id: baseId })).json;
  const r = await call("create_variants", { job_id: baseId, count: 3, tested_variable: "hook", idempotency_key: key() });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.variants.length, 3);
  assert.equal(r.json.variant_group_id, baseStatus.plan.variant_group_id);
  assert.equal(r.json.base_job_id, baseId);
  assert.equal(stubs.calls.variants, 1);

  const hookIds = new Set<string>([baseStatus.plan.hook_id]);
  for (const v of r.json.variants) {
    const ad = (await call("get_ad_status", { job_id: v.job_id })).json;
    assert.equal(ad.status, "awaiting_approval");
    assert.equal(ad.variant_of, baseId);
    assert.equal(ad.variant_group_id, baseStatus.plan.variant_group_id);
    assert.equal(ad.plan.variant.tested_variable, "hook");
    assert.equal(ad.plan.variant.base_ad_id, baseId);
    assert.deepEqual(ad.plan.variant.diff, v.diff);
    for (const d of v.diff as { path: string }[]) {
      assert.match(d.path, /^(hook|hook_id|scenes\[s1\]\.(voiceover|on_screen_text))$/);
    }
    assert.notEqual(ad.plan.hook, baseStatus.plan.hook);
    assert.equal(ad.plan.angle, baseStatus.plan.angle); // untouched
    assert.deepEqual(ad.plan.cta, baseStatus.plan.cta);
    hookIds.add(ad.plan.hook_id);
  }
  assert.equal(hookIds.size, 4, "each hook idea gets its own hook_id");
  const after = (await call("get_ad_status", { job_id: baseId })).json;
  assert.equal(after.plan_version, 1);
  assert.equal(after.plan.hook, baseStatus.plan.hook);
  const list = (await call("list_ads", { limit: 10 })).json.ads as { variant_of: string | null }[];
  assert.equal(list.length, 4);
  assert.equal(list.filter((a) => a.variant_of === baseId).length, 3);
});

await test("create_variants works for all five tested variables, and non-hook variants keep the hook_id", async () => {
  for (const variable of TESTED_VARIABLES) {
    const { service, ctx } = setup();
    const { call } = await connect(service, ctx);
    const baseId = await newReadyAd(call);
    const b = (await call("get_ad_status", { job_id: baseId })).json;
    const r = await call("create_variants", { job_id: baseId, count: 2, tested_variable: variable, idempotency_key: key() });
    assert.equal(r.isError, false, `${variable}: ${r.text}`);
    assert.equal(r.json.variants.length, 2);
    for (const v of r.json.variants) {
      assert.ok(v.diff.length > 0, variable);
      const ad = (await call("get_ad_status", { job_id: v.job_id })).json;
      if (variable !== "hook") assert.equal(ad.plan.hook_id, b.plan.hook_id, `${variable} keeps the hook idea`);
    }
  }
});

await test("a provider that touches a forbidden field is rejected, and nothing is created", async () => {
  for (const leak of ["duration", "cta", "aspect", "scene_order"] as const) {
    const { service, ctx } = setup({ variantLeak: leak });
    const { call } = await connect(service, ctx);
    const baseId = await newReadyAd(call);
    const r = await call("create_variants", { job_id: baseId, count: 3, tested_variable: "hook", idempotency_key: key() });
    assert.equal(r.isError, true, leak);
    assert.match(r.text, /^\[invalid_input\] Variant 1 changes fields outside "hook"/, leak);
    assert.equal(service.listAds(ctx, 50).length, 1, `${leak}: no ads created`);
    assert.equal(service.store.variantGroups.size, 0, `${leak}: no group created`);
  }
});

await test("duplicates are rejected: identical variants, and a near-copy of the base", async () => {
  const a = setup({ variantDuplicate: "twice" });
  const ca = await connect(a.service, a.ctx);
  const idA = await newReadyAd(ca.call);
  const r1 = await ca.call("create_variants", { job_id: idA, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.match(r1.text, /^\[invalid_input\] Variant 2 is too similar to Variant 1 \(word distance 0\.00/);
  assert.equal(a.service.listAds(a.ctx, 50).length, 1);

  const b = setup({ variantDuplicate: "near_copy" });
  const cb = await connect(b.service, b.ctx);
  const idB = await newReadyAd(cb.call);
  const r2 = await cb.call("create_variants", { job_id: idB, count: 1, tested_variable: "hook", idempotency_key: key() });
  assert.match(r2.text, /^\[invalid_input\] Variant 1 is too similar to the base/);
});

await test("idempotency: replay returns the same variants, concurrent calls share one run", async () => {
  const { service, stubs, ctx } = setup();
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  const k = key();
  const args = { job_id: baseId, count: 2, tested_variable: "cta", idempotency_key: k };
  const [a, b] = await Promise.all([call("create_variants", args), call("create_variants", args)]);
  assert.equal(a.isError, false, a.text);
  assert.deepEqual(a.json.variants.map((v: { job_id: string }) => v.job_id), b.json.variants.map((v: { job_id: string }) => v.job_id));
  const again = await call("create_variants", args);
  assert.deepEqual(again.json.variants.map((v: { job_id: string }) => v.job_id), a.json.variants.map((v: { job_id: string }) => v.job_id));
  assert.equal(stubs.calls.variants, 1);
  assert.equal(service.listAds(ctx, 50).length, 3);
  const changed = await call("create_variants", { ...args, count: 3 });
  assert.match(changed.text, /^\[conflict\]/);
});

await test("a group tests one variable; more variants of the same variable stay distinct; the cap holds", async () => {
  const { service, ctx } = setup({}, { maxVariantsPerBase: 4 });
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  const first = await call("create_variants", { job_id: baseId, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.equal(first.isError, false, first.text);
  const other = await call("create_variants", { job_id: baseId, count: 1, tested_variable: "cta", idempotency_key: key() });
  assert.match(other.text, /^\[conflict\].*already tests "hook"/);
  const more = await call("create_variants", { job_id: baseId, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.equal(more.isError, false, more.text);
  const hooks = new Set<string>();
  for (const v of [...first.json.variants, ...more.json.variants]) hooks.add((await call("get_ad_status", { job_id: v.job_id })).json.plan.hook);
  assert.equal(hooks.size, 4, "no repeated hooks across calls");
  const over = await call("create_variants", { job_id: baseId, count: 1, tested_variable: "hook", idempotency_key: key() });
  assert.match(over.text, /^\[rate_limited\]/);
  assert.equal(service.listAds(ctx, 50).length, 5);
});

await test("base must be ready or finished; a finished ad can be the base", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const early = await call("create_ad", { prompt: "Spring deep-clean special for families", idempotency_key: key() });
  const tooSoon = await call("create_variants", { job_id: early.json.job_id, count: 1, tested_variable: "hook", idempotency_key: key() });
  assert.match(tooSoon.text, /^\[conflict\]/);
  await waitForStatus(call, early.json.job_id, "awaiting_approval");

  const cancelled = await newReadyAd(call);
  await call("cancel_ad", { job_id: cancelled });
  assert.match((await call("create_variants", { job_id: cancelled, count: 1, tested_variable: "hook", idempotency_key: key() })).text, /^\[conflict\]/);

  const est = (await call("estimate_cost", { job_id: early.json.job_id })).json.credits;
  await call("approve_and_render", { job_id: early.json.job_id, max_credits: est, idempotency_key: key() });
  await waitForStatus(call, early.json.job_id, "completed");
  const fromWinner = await call("create_variants", { job_id: early.json.job_id, count: 2, tested_variable: "angle", idempotency_key: key() });
  assert.equal(fromWinner.isError, false, fromWinner.text);
});

await test("server-owned fields come from the base, whatever the provider returns", async () => {
  const stubs = createStubProviders({ delayMs: 10 });
  const original = stubs.variants.generate.bind(stubs.variants);
  stubs.variants.generate = async (input) => {
    const out = (await original(input)) as ScenePlan[];
    for (const p of out) {
      p.hook_id = "evil_hook";
      p.variant_group_id = "vg_evil";
      p.template = { id: "evil", version: "9" };
      p.schema_version = "1.1";
    }
    return out;
  };
  const service = new AdService(stubs, { retryBaseMs: 5, limits: TEST_LIMITS });
  const ctx = fullAccess("acct_a");
  service.grantCredits(ctx.accountId, 100, "t");
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  const b = (await call("get_ad_status", { job_id: baseId })).json;
  const r = await call("create_variants", { job_id: baseId, count: 2, tested_variable: "cta", idempotency_key: key() });
  assert.equal(r.isError, false, r.text);
  for (const v of r.json.variants) {
    const p = (await call("get_ad_status", { job_id: v.job_id })).json.plan;
    assert.equal(p.hook_id, b.plan.hook_id);
    assert.equal(p.variant_group_id, b.plan.variant_group_id);
    assert.deepEqual(p.template, b.plan.template);
    assert.ok(!v.diff.some((d: { path: string }) => /template|hook_id|variant_group_id/.test(d.path)));
  }
  // Hook variants get a fresh server-minted id, never the provider's "evil_hook".
  const secondBase = await newReadyAd(call);
  const sb = (await call("get_ad_status", { job_id: secondBase })).json;
  const h = await call("create_variants", { job_id: secondBase, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.equal(h.isError, false, h.text);
  const ids = new Set<string>([sb.plan.hook_id]);
  for (const v of h.json.variants) {
    const p = (await call("get_ad_status", { job_id: v.job_id })).json.plan;
    assert.match(p.hook_id, /^h_[0-9a-f]{12}$/);
    assert.notEqual(p.hook_id, "evil_hook");
    assert.equal(p.variant_group_id, sb.plan.variant_group_id);
    ids.add(p.hook_id);
  }
  assert.equal(ids.size, 3);
});

await test("attribution ids are minted by the server and unique per ad", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const a = (await call("get_ad_status", { job_id: await newReadyAd(call) })).json.plan;
  const b = (await call("get_ad_status", { job_id: await newReadyAd(call) })).json.plan;
  for (const p of [a, b]) {
    assert.match(p.hook_id, /^h_[0-9a-f]{12}$/);
    assert.match(p.variant_group_id, /^vg_[0-9a-f]{12}$/);
  }
  assert.notEqual(a.hook_id, b.hook_id);
  assert.notEqual(a.variant_group_id, b.variant_group_id);
});

await test("brand rules apply to variants: one can block while its sibling is approved independently", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "forbidden_claim", pattern: "stop scrubbing" }] });
  const baseId = await newReadyAd(call, { brand_kit_id: kitId });
  const r = await call("create_variants", { job_id: baseId, count: 2, tested_variable: "hook", idempotency_key: key() });
  assert.equal(r.isError, false, r.text);
  const [clean, flagged] = r.json.variants as { job_id: string; check: { status: string } }[];
  assert.equal(clean.check.status, "pass");
  assert.equal(flagged.check.status, "block"); // "Stop scrubbing and start living"
  const f = (await call("check_ad", { job_id: flagged.job_id })).json;
  assert.equal(f.findings[0].rule_id, "r1");

  const est = (await call("estimate_cost", { job_id: clean.job_id })).json.credits as number;
  const before = service.getBalance(ctx).available;
  assert.match((await call("approve_and_render", { job_id: flagged.job_id, max_credits: est, idempotency_key: key() })).text, /^\[blocked_by_rule\]/);
  assert.equal((await call("approve_and_render", { job_id: clean.job_id, max_credits: est, idempotency_key: key() })).isError, false);
  await waitForStatus(call, clean.job_id, "completed");
  assert.equal(service.getBalance(ctx).available, before - est);
  assert.equal((await call("get_ad_status", { job_id: flagged.job_id })).json.status, "awaiting_approval");
  assert.equal((await call("get_ad_status", { job_id: baseId })).json.status, "awaiting_approval");
});

await test("tenant isolation and scopes apply to variants", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  const other = await connect(service, fullAccess("acct_b"));
  assert.match((await other.call("create_variants", { job_id: baseId, count: 1, tested_variable: "hook", idempotency_key: key() })).text, /^\[not_found\]/);
  const readOnly = await connect(service, { accountId: ctx.accountId, scopes: new Set(["ads:read"]) });
  assert.match((await readOnly.call("create_variants", { job_id: baseId, count: 1, tested_variable: "hook", idempotency_key: key() })).text, /^\[forbidden\]/);
  assert.equal(service.store.variantGroups.size, 0);
  assert.equal(service.listAds(ctx, 50).length, 1);
  // Even with the same idempotency key, another account gets its own namespace.
  const k = key();
  const mine = await call("create_variants", { job_id: baseId, count: 1, tested_variable: "hook", idempotency_key: k });
  assert.equal(mine.isError, false);
  assert.match((await other.call("create_variants", { job_id: baseId, count: 1, tested_variable: "hook", idempotency_key: k })).text, /^\[not_found\]/);
});

await test("input limits and the audit trail", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const baseId = await newReadyAd(call);
  assert.equal((await call("create_variants", { job_id: baseId, count: 0, tested_variable: "hook", idempotency_key: key() })).isError, true);
  assert.equal((await call("create_variants", { job_id: baseId, count: 6, tested_variable: "hook", idempotency_key: key() })).isError, true);
  assert.equal((await call("create_variants", { job_id: baseId, count: 1, tested_variable: "color", idempotency_key: key() })).isError, true);
  assert.match((await call("create_variants", { job_id: "ad_missing", count: 1, tested_variable: "hook", idempotency_key: key() })).text, /^\[not_found\]/);
  await call("create_variants", { job_id: baseId, count: 2, tested_variable: "offer", idempotency_key: key() });
  const entry = service.store.audit.find((a) => a.action === "variants.create")!;
  assert.ok(entry);
  assert.equal((entry.detail as { ad_ids: string[] }).ad_ids.length, 2);
  assert.equal(service.store.verifyAudit(ctx.accountId), true);
});

await test("REST: POST /v1/ads/:id/variants shares the service layer", async () => {
  const { service, ctx } = setup();
  const server = createApp(service, { apiKeys: new Map([["k", ctx]]) }).listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = (extra: Record<string, string> = {}) => ({ authorization: "Bearer k", "content-type": "application/json", ...extra });
  try {
    const created = (await (await fetch(`${url}/v1/ads`, { method: "POST", headers: h({ "idempotency-key": key() }), body: JSON.stringify({ prompt: "Spring deep-clean special for families" }) })).json()) as { job_id: string };
    for (let i = 0; i < 100; i++) {
      const s = (await (await fetch(`${url}/v1/ads/${created.job_id}`, { headers: h() })).json()) as { status: string };
      if (s.status === "awaiting_approval") break;
      await sleep(10);
    }
    const path = `${url}/v1/ads/${created.job_id}/variants`;
    assert.equal((await fetch(path, { method: "POST", headers: h(), body: JSON.stringify({ count: 2, tested_variable: "cta" }) })).status, 400); // no key
    assert.equal((await fetch(path, { method: "POST", headers: h({ "idempotency-key": key() }), body: JSON.stringify({ count: 2, tested_variable: "color" }) })).status, 400);
    const k = key();
    const res = await fetch(path, { method: "POST", headers: h({ "idempotency-key": k }), body: JSON.stringify({ count: 2, tested_variable: "cta" }) });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { variants: { job_id: string; diff: { path: string }[] }[]; schema_version: number };
    assert.equal(body.variants.length, 2);
    assert.equal(body.schema_version, 1);
    assert.ok(body.variants[0].diff.every((d) => d.path.startsWith("cta.")));
    const replay = (await (await fetch(path, { method: "POST", headers: h({ "idempotency-key": k }), body: JSON.stringify({ count: 2, tested_variable: "cta" }) })).json()) as typeof body;
    assert.deepEqual(replay.variants.map((v) => v.job_id), body.variants.map((v) => v.job_id));
    assert.equal((await fetch(path, { method: "POST", headers: h({ "idempotency-key": k }), body: JSON.stringify({ count: 3, tested_variable: "cta" }) })).status, 409);
  } finally {
    server.close();
  }
});

console.log(`variants passed: ${n} checks`);
process.exit(0);
