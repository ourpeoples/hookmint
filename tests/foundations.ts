import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fullAccess, type Ctx } from "../src/core/context.js";
import { AdError } from "../src/core/errors.js";
import { ProviderCalls } from "../src/core/provider-calls.js";
import { ScenePlan, upgradePlan } from "../src/core/schemas.js";
import { fitSceneDurations, MAX_EXTRA_S, VOICE_TAIL_S } from "../src/render/voice-fit.js";
import { createApp } from "../src/server/app.js";
import { connect, key, newReadyAd, setup, sleep, waitForStatus } from "./helpers.js";
import { auditOf, verifyAudit, reservationsOf, redeliverAll, adOf, tamperAudit } from "./inspect.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok", name);
};

await test("idempotency: same key replays, changed request conflicts", async () => {
  const { service, stubs, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const k = key();
  const args = { prompt: "Spring deep-clean special for busy families", idempotency_key: k };
  const a = await call("create_ad", args);
  const b = await call("create_ad", args);
  assert.equal(a.json.job_id, b.json.job_id);
  assert.equal((await service.listAds(ctx, 10)).length, 1);
  const c = await call("create_ad", { ...args, prompt: "A different request entirely" });
  assert.equal(c.isError, true);
  assert.match(c.text, /^\[conflict\]/);
  await waitForStatus(call, a.json.job_id, "awaiting_approval");
  assert.equal(stubs.calls.script, 1);
});

await test("tenant isolation: another account cannot read, list or act on an ad", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const other = fullAccess("acct_b");
  await service.grantCredits(other.accountId, 500, "grant");
  const b = await connect(service, other);
  assert.match((await b.call("get_ad_status", { job_id: id })).text, /^\[not_found\]/);
  assert.equal((await b.call("list_ads", { limit: 10 })).json.ads.length, 0);
  assert.match((await b.call("approve_and_render", { job_id: id, max_credits: 100, idempotency_key: key() })).text, /^\[not_found\]/);
  assert.match((await b.call("cancel_ad", { job_id: id })).text, /^\[not_found\]/);
});

await test("scopes: spending needs the spend scope", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const limited: Ctx = { accountId: ctx.accountId, scopes: new Set(["ads:read", "ads:create", "ads:approve"]) };
  const l = await connect(service, limited);
  assert.match((await l.call("approve_and_render", { job_id: id, max_credits: 100, idempotency_key: key() })).text, /^\[forbidden\]/);
  assert.equal((await l.call("get_ad_status", { job_id: id })).isError, false);
});

await test("credits: max_credits guard, insufficient balance, reserve then settle", async () => {
  const { service, ctx } = await setup({}, {}, 5); // too few credits
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  assert.ok(est > 5);
  assert.match((await call("approve_and_render", { job_id: id, max_credits: est - 1, idempotency_key: key() })).text, /^\[invalid_input\]/);
  assert.match((await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() })).text, /^\[insufficient_credits\]/);
  assert.equal((await await service.getBalance(ctx)).available, 5); // nothing reserved by the refusals
  await service.grantCredits(ctx.accountId, 100, "top up");
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.equal((await await service.getBalance(ctx)).held, est);
  await waitForStatus(call, id, "completed");
  assert.deepEqual(await service.getBalance(ctx), { available: 105 - est, held: 0 });
});

await test("approve is single-flight: a second approve with a new key conflicts, same key replays", async () => {
  const { service, stubs, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  const k = key();
  const first = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: k });
  const replay = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: k });
  assert.equal(replay.isError, false);
  assert.equal(replay.json.job_id, first.json.job_id);
  assert.match((await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() })).text, /^\[conflict\]/);
  await waitForStatus(call, id, "completed");
  assert.equal(stubs.calls.render, 2);
  assert.equal((await reservationsOf(service)).length, 1);
});

await test("outbox redelivery does not repeat work or spend", async () => {
  const { service, stubs, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  await waitForStatus(call, id, "completed");
  const counts = { ...stubs.calls };
  const balance = await service.getBalance(ctx);
  await redeliverAll(service);
  await sleep(100);
  assert.deepEqual(stubs.calls, counts);
  assert.deepEqual(await service.getBalance(ctx), balance);
  assert.equal((await adOf(service, id))!.plans.length, 1);
});

await test("provider calls: run once per key, share in-flight work, retry transient errors", async () => {
  const pc = new ProviderCalls(2);
  let runs = 0;
  const slow = async () => { runs++; await sleep(20); return "ok"; };
  const [a, b] = await Promise.all([pc.runOnce("k1", { provider: "p", cost_credits: 1 }, slow), pc.runOnce("k1", { provider: "p", cost_credits: 1 }, slow)]);
  assert.equal(a, "ok"); assert.equal(b, "ok");
  await pc.runOnce("k1", { provider: "p", cost_credits: 1 }, slow);
  assert.equal(runs, 1);

  let flaky = 0;
  await pc.runOnce("k2", { provider: "p", cost_credits: 1 }, async () => { if (flaky++ < 2) throw new AdError("provider_unavailable", "down"); return 1; });
  assert.equal(flaky, 3);
  assert.equal(pc.get("k2")!.attempts, 3);

  await assert.rejects(pc.runOnce("k3", { provider: "p", cost_credits: 1 }, async () => { throw new AdError("invalid_input", "bad"); }));
  assert.equal(pc.get("k3")!.attempts, 1); // not retried
  assert.equal(pc.get("k3")!.status, "failed");
});

await test("a transient provider failure is retried and the job still completes once", async () => {
  const { service, stubs, ctx } = await setup({ failVisualTimes: 1 });
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  const done = await waitForStatus(call, id, "completed");
  assert.equal(done.renders.length, 2);
  assert.equal(stubs.calls.visual, (await adOf(service, id))!.plans[0].scenes.length + 1); // exactly one retry
});

await test("cancel mid-run releases the reservation and stops later stages", async () => {
  const { service, stubs, ctx } = await setup({ delayMs: 60 });
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const start = (await await service.getBalance(ctx)).available;
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.equal((await await service.getBalance(ctx)).held, est);
  await sleep(20);
  const c = await call("cancel_ad", { job_id: id });
  assert.equal(c.json.status, "cancelled");
  await sleep(300);
  assert.equal(stubs.calls.render, 0);
  assert.deepEqual(await service.getBalance(ctx), { available: start, held: 0 });
  assert.equal((await call("cancel_ad", { job_id: id })).isError, false); // repeat is safe
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "cancelled");
});

await test("regenerate_scene: estimate without confirm, spend with confirm, budget enforced", async () => {
  const { service, ctx } = await setup({}, { regenBudget: 1 });
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const start = (await await service.getBalance(ctx)).available;
  const dry = await call("regenerate_scene", { job_id: id, scene_id: "s2", instruction: "show a family", idempotency_key: key() });
  assert.equal(dry.json.started, false);
  assert.equal((await await service.getBalance(ctx)).available, start);
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "awaiting_approval");

  assert.match((await call("regenerate_scene", { job_id: id, scene_id: "s2", instruction: "show a family", confirm: true, idempotency_key: key() })).text, /max_credits is required/);
  const k = key();
  const run = await call("regenerate_scene", { job_id: id, scene_id: "s2", instruction: "show a family", confirm: true, max_credits: 10, idempotency_key: k });
  assert.equal(run.json.started, true);
  await waitForStatus(call, id, "awaiting_approval");
  assert.equal((await await service.getBalance(ctx)).available, start - run.json.estimate.credits);

  const second = await call("regenerate_scene", { job_id: id, scene_id: "s3", instruction: "brighter", confirm: true, max_credits: 10, idempotency_key: key() });
  assert.match(second.text, /^\[rate_limited\]/);
});

await test("audit log is a verifiable hash chain and detects tampering", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  await waitForStatus(call, id, "completed");
  assert.ok((await auditOf(service)).length >= 2);
  assert.equal(await verifyAudit(service, ctx.accountId), true);
  await tamperAudit(service, 1, { action: "tampered", detail: { credits: 0 } });
  assert.equal(await verifyAudit(service, ctx.accountId), false);
});

await test("plans written before schema_version are upgraded on read", async () => {
  const legacy = {
    hook: "h", cta: { text: "Go" }, aspect_ratios: ["9:16"],
    scenes: [
      { id: "s1", duration_s: 5, visual_prompt: "a", visual_source: "stock", voiceover: "v" },
      { id: "s2", duration_s: 5, visual_prompt: "b", visual_source: "stock", voiceover: "w" },
    ],
  };
  assert.equal(ScenePlan.safeParse(legacy).success, false);
  const up = ScenePlan.parse(upgradePlan(legacy));
  assert.equal(up.schema_version, "1.1");
  assert.deepEqual(up.scenes[0].claims, []);
});

await test("REST /v1 shares the service layer: auth, idempotency, approve, error mapping", async () => {
  const { service, ctx } = await setup();
  const keys = new Map([["secret-key", ctx]]);
  const server = createApp(service, { apiKeys: keys }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = (extra: Record<string, string> = {}) => ({ authorization: "Bearer secret-key", "content-type": "application/json", ...extra });
  try {
    assert.equal((await fetch(`${base}/v1/ads`)).status, 401);
    const body = JSON.stringify({ prompt: "Spring deep-clean special for busy families", duration_s: 15 });
    assert.equal((await fetch(`${base}/v1/ads`, { method: "POST", headers: h(), body })).status, 400); // no Idempotency-Key
    const k = key();
    const r1 = await fetch(`${base}/v1/ads`, { method: "POST", headers: h({ "idempotency-key": k }), body });
    const created = (await r1.json()) as { job_id: string; schema_version: number; warnings: string[] };
    assert.equal(r1.status, 201);
    assert.equal(created.schema_version, 1);
    const r2 = await fetch(`${base}/v1/ads`, { method: "POST", headers: h({ "idempotency-key": k }), body });
    assert.equal(((await r2.json()) as { job_id: string }).job_id, created.job_id);

    for (let i = 0; i < 100; i++) {
      const s = (await (await fetch(`${base}/v1/ads/${created.job_id}`, { headers: h() })).json()) as { status: string };
      if (s.status === "awaiting_approval") break;
      await sleep(10);
    }
    const est = (await (await fetch(`${base}/v1/ads/${created.job_id}/estimate`, { headers: h() })).json()) as { credits: number };
    const tooLow = await fetch(`${base}/v1/ads/${created.job_id}/approve`, { method: "POST", headers: h({ "idempotency-key": key() }), body: JSON.stringify({ max_credits: est.credits - 1 }) });
    assert.equal(tooLow.status, 400);
    const ok = await fetch(`${base}/v1/ads/${created.job_id}/approve`, { method: "POST", headers: h({ "idempotency-key": key() }), body: JSON.stringify({ max_credits: est.credits }) });
    assert.equal(ok.status, 202);
    assert.equal((await fetch(`${base}/v1/ads/ad_missing`, { headers: h() })).status, 404);
  } finally {
    server.close();
  }
});

await test("voice fit: a scene stays up until its line is finished, is never shortened, and the stretch is capped", async () => {
  const scenes = [{ id: "s1", duration_s: 4 }, { id: "s2", duration_s: 4 }, { id: "s3", duration_s: 3 }, { id: "s4", duration_s: 4 }];
  const r = fitSceneDurations(scenes, { s1: 4.62, s2: 2.1, s3: undefined, s4: 30 });
  assert.equal(r.durations[0], Math.ceil((4.62 + VOICE_TAIL_S) * 10) / 10, "a long line lengthens its scene, rounded up to a tenth");
  assert.equal(r.durations[1], 4, "a short line never shortens a scene");
  assert.equal(r.durations[2], 3, "no voice leaves the scene alone");
  assert.equal(r.durations[3], 4 + MAX_EXTRA_S, "the stretch is capped");
  assert.deepEqual(r.tooLong, ["s4"]);
  assert.deepEqual(r.lengthened.map((l) => l.id), ["s1", "s4"]);
  assert.deepEqual(fitSceneDurations(scenes, {}).lengthened, [], "nothing measured, nothing changes");
  assert.equal(fitSceneDurations([{ id: "a", duration_s: 5 }], { a: 4.6 }).durations[0], 5, "a line that fits with its tail changes nothing");
  assert.equal(fitSceneDurations([{ id: "a", duration_s: 5 }], { a: Number.NaN }).durations[0], 5, "a bad measurement is ignored");
});

await test("REST edits: a script can be edited and a scene regenerated from the command line, with the same rules as the tools", async () => {
  const { service, ctx } = await setup();
  const keys = new Map([["secret-key", ctx]]);
  const server = createApp(service, { apiKeys: keys }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = (extra: Record<string, string> = {}) => ({ authorization: "Bearer secret-key", "content-type": "application/json", ...extra });
  try {
    const made = await fetch(`${base}/v1/ads`, { method: "POST", headers: h({ "idempotency-key": key() }), body: JSON.stringify({ prompt: "Spring deep-clean special for busy families", duration_s: 15 }) });
    const id = ((await made.json()) as { job_id: string }).job_id;
    for (let i = 0; i < 100; i++) {
      const s = (await (await fetch(`${base}/v1/ads/${id}`, { headers: h() })).json()) as { status: string };
      if (s.status === "awaiting_approval") break;
      await sleep(10);
    }
    const patch = (body: unknown, extra: Record<string, string> = {}, auth = true) => fetch(`${base}/v1/ads/${id}/script`, { method: "PATCH", headers: auth ? h(extra) : { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await patch({ hook: "x" }, {}, false)).status, 401, "editing needs a key");
    const edited = await patch({ hook: "Your weekend back, starting now", cta_text: "Book today", scenes: [{ scene_id: "s1", voiceover: "A fresh start for your home.", on_screen_text: "Fresh start" }] });
    assert.equal(edited.status, 200);
    const view = (await edited.json()) as { plan: { hook: string; cta: { text: string }; scenes: { id: string; voiceover: string; on_screen_text?: string }[] }; plan_version: number };
    assert.equal(view.plan.hook, "Your weekend back, starting now");
    assert.equal(view.plan.cta.text, "Book today");
    assert.equal(view.plan.scenes[0].voiceover, "A fresh start for your home.");
    assert.equal(view.plan_version, 2, "each edit is a new plan version");
    assert.equal((await patch({ scenes: [{ scene_id: "s99", voiceover: "x" }] })).status, 400, "an unknown scene is refused");
    assert.equal((await patch({ scenes: [{ scene_id: "s1", duration_s: 99 }] })).status, 400, "bad input is refused by the schema");
    assert.equal((await fetch(`${base}/v1/ads/ad_missing/script`, { method: "PATCH", headers: h(), body: "{}" })).status, 404);

    const regen = (body: unknown, k?: string) => fetch(`${base}/v1/ads/${id}/scenes/s2/regenerate`, { method: "POST", headers: h(k ? { "idempotency-key": k } : {}), body: JSON.stringify(body) });
    assert.equal((await regen({ instruction: "show a family" })).status, 400, "the Idempotency-Key header is required");
    const dry = await regen({ instruction: "show a family" }, key());
    assert.equal(dry.status, 200);
    const dryBody = (await dry.json()) as { started: boolean; estimate: { credits: number } };
    assert.equal(dryBody.started, false, "without confirm it only estimates");
    assert.ok(dryBody.estimate.credits > 0);
    assert.equal((await regen({ instruction: "show a family", confirm: true }, key())).status, 400, "max_credits is required to spend");
    const run = await regen({ instruction: "show a family", confirm: true, max_credits: dryBody.estimate.credits }, key());
    assert.equal(run.status, 202);
    assert.equal(((await run.json()) as { started: boolean }).started, true);
  } finally {
    server.close();
  }
});

console.log(`foundations passed: ${n} checks`);
process.exit(0);
