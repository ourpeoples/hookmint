import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fullAccess } from "../src/core/context.js";
import { AdError } from "../src/core/errors.js";
import { ProviderCalls } from "../src/core/provider-calls.js";
import { DAY, DEFAULT_LIMITS, FailureLimiter, FetchQuota, HOUR, type Limits, MINUTE, parseLimits, RateLimiter, waitText } from "../src/core/limits.js";
import { AdService } from "../src/core/service.js";
import { MediaIngestor } from "../src/net/ingest.js";
import { createProviders, serviceOptions } from "../src/providers/index.js";
import { createStubProviders } from "../src/providers/stub.js";
import { createApp } from "../src/server/app.js";
import { connect, key, newReadyAd, sleep, TEST_LIMITS, waitForStatus, newService } from "./helpers.js";
import { kitCount, pendingLogos, putRender } from "./inspect.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};
const limited = (fn: () => unknown, re: RegExp, retry?: number | ((s: number) => boolean)) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof AdError && e.code === "rate_limited", `expected rate_limited, got ${e}`);
    assert.match(e.message, re);
    if (typeof retry === "number") assert.equal(e.retry_after, retry);
    if (typeof retry === "function") assert.ok(retry(e.retry_after!), `retry_after was ${e.retry_after}`);
    return;
  }
  assert.fail("expected the call to be refused");
};
const clock = () => { const c = { t: 1_000_000 }; return Object.assign(() => c.t, { c, advance: (ms: number) => (c.t += ms) }); };

// ============ the building blocks ============

await test("limiter: a sliding window that tells you exactly when to come back, and a refused request costs nothing", async () => {
  const now = clock(); const rl = new RateLimiter(now);
  const take = (w = 1) => rl.take("a", "k", 3, HOUR, { weight: w, label: "things" });
  take(); now.advance(10 * MINUTE); take(); now.advance(10 * MINUTE); take(); // used at 0, 10 and 20 minutes
  limited(() => take(), /all 3 things allowed per hour\. Try again in 40 minutes\./, 40 * 60);
  now.advance(5 * MINUTE);
  limited(() => take(), /Try again in 35 minutes/, 35 * 60);
  now.advance(35 * MINUTE); // the first use is now exactly one hour old
  take();                   // fits again, because the refused attempts above were never recorded
  limited(() => take(), /./, 10 * 60 - 0);
});

await test("limiter: weighted uses wait only as long as needed, and a request larger than the limit is refused outright", async () => {
  const now = clock(); const rl = new RateLimiter(now);
  const take = (w: number) => rl.take("a", "k", 10, 60_000, { weight: w, label: "things" });
  take(5); now.advance(30_000); take(5); now.advance(10_000); // 5 used 40s ago, 5 used 10s ago
  limited(() => take(3), /./, 20);   // frees up when the first 5 expire, in 20 s
  limited(() => take(8), /./, 50);   // needs both to expire, in 50 s
  limited(() => take(1), /./, 20);
  assert.throws(() => take(11), (e: unknown) => e instanceof AdError && e.code === "invalid_input" && /more than the limit of 10 things per minute/.test(e.message));
  now.advance(20_000); take(3);
});

await test("limiter: accounts and actions are counted separately, and idle accounts do not pile up in memory", async () => {
  const now = clock(); const rl = new RateLimiter(now);
  rl.take("a", "x", 1, HOUR, { label: "x" });
  limited(() => rl.take("a", "x", 1, HOUR, { label: "x" }), /./);
  rl.take("b", "x", 1, HOUR, { label: "x" });  // another account
  rl.take("a", "y", 1, HOUR, { label: "y" });  // another action
  for (let i = 0; i < 50_100; i++) rl.take(`acct${i}`, "x", 5, MINUTE, { label: "x" });
  assert.ok(rl.size() > 50_000);
  now.advance(2 * MINUTE);
  rl.take("late", "x", 5, MINUTE, { label: "x" });
  assert.ok(rl.size() < 100, `old entries are swept, ${rl.size()} left`);
});

await test("wait text and configuration: plain durations; HOOKMINT_LIMITS is validated and a mistake stops startup", async () => {
  assert.equal(waitText(1), "1 seconds".replace("1 seconds", "1 seconds"));
  assert.equal(waitText(40), "40 seconds"); assert.equal(waitText(120), "2 minutes"); assert.equal(waitText(3600), "60 minutes"); assert.equal(waitText(3 * 3600), "3 hours");
  assert.deepEqual(parseLimits(undefined), DEFAULT_LIMITS); assert.deepEqual(parseLimits("  "), DEFAULT_LIMITS);
  assert.deepEqual(parseLimits('{"createAdPerHour": 5, "maxActiveJobs": 1}'), { ...DEFAULT_LIMITS, createAdPerHour: 5, maxActiveJobs: 1 });
  for (const v of Object.values(DEFAULT_LIMITS)) assert.ok(Number.isInteger(v) && v >= 1);
  for (const [bad, re] of [["not json", /must be a JSON object/], ["[1]", /not valid/], ['{"nope": 1}', /unknown setting nope/], ['{"createAdPerHour": 0}', /createAdPerHour must be a whole number of at least 1/], ['{"createAdPerHour": -3}', /createAdPerHour/], ['{"createAdPerHour": 1.5}', /createAdPerHour/], ['{"createAdPerHour": "10"}', /createAdPerHour/], ['{"createAdPerHour": null}', /createAdPerHour/]] as const) {
    assert.throws(() => parseLimits(bad), re, bad);
  }
  assert.match((() => { try { parseLimits('{"x":1}'); } catch (e) { return (e as Error).message; } return ""; })(), /Settings: requestsPerMinute, createAdPerHour/);
});

await test("download quota: counts and bytes per account per day, parallel downloads cannot slip past, and the day rolls over", async () => {
  const now = clock(); const q = new FetchQuota({ fetchesPerDay: 3, fetchBytesPerDay: 1000 }, now);
  q.before("a"); q.after("a", 400); q.before("a"); q.after("a", 400);
  q.before("a"); // third attempt allowed, but not yet finished
  limited(() => q.before("a"), /limit of 3 downloads a day/, DAY / 1000);
  q.after("a", 100);
  q.before("b"); q.after("b", 1); // another account has its own allowance
  now.advance(DAY - 1000); limited(() => q.before("a"), /./, 1);
  now.advance(1500); q.before("a"); // the oldest download has aged out
  const bytes = new FetchQuota({ fetchesPerDay: 100, fetchBytesPerDay: 1000 }, now);
  bytes.before("a"); bytes.after("a", 1500); // one file may overshoot, but never more than one
  limited(() => bytes.before("a"), /daily download size limit/);
  now.advance(DAY + 1); bytes.before("a");
  const par = new FetchQuota({ fetchesPerDay: 2, fetchBytesPerDay: 1e9 }, now);
  par.before("p"); par.before("p"); // two started and none finished
  limited(() => par.before("p"), /limit of 2/);
});

await test("retries: a provider's rate limit is retried, but our own limits are final and never retried", async () => {
  const pc = new ProviderCalls(1);
  let provider = 0;
  await pc.runOnce("p", { provider: "x", cost_credits: 0 }, async () => { if (provider++ < 2) throw new AdError("rate_limited", "provider is busy", 0.01); return "ok"; });
  assert.equal(provider, 3, "a provider's 429 is retried");
  let ours = 0; const t0 = Date.now();
  await assert.rejects(pc.runOnce("q", { provider: "x", cost_credits: 0 }, async () => { ours++; throw new AdError("rate_limited", "daily limit", 86_400, { retry: false }); }));
  assert.equal(ours, 1, "our own limit is not retried");
  assert.ok(Date.now() - t0 < 500, "and does not wait");
  const q = new FetchQuota({ fetchesPerDay: 1, fetchBytesPerDay: 1e9 });
  q.before("a");
  try { q.before("a"); assert.fail("should refuse"); } catch (e) { assert.equal((e as AdError).retry, false); }
  const rl = new RateLimiter(); rl.take("a", "k", 1, HOUR, { label: "x" });
  try { rl.take("a", "k", 1, HOUR, { label: "x" }); assert.fail("should refuse"); } catch (e) { assert.equal((e as AdError).retry, false); }
  assert.equal(new AdError("rate_limited", "x").retry, true, "a plain rate_limited error defaults to retryable");
});

await test("failure limiter: counts only failures, refuses further failures from that address, and the window expires", async () => {
  const now = clock(); const f = new FailureLimiter(3, 10 * MINUTE, now);
  f.failed("1.1.1.1"); f.failed("1.1.1.1"); f.failed("1.1.1.1");
  limited(() => f.failed("1.1.1.1"), /Too many failed attempts\. Try again in 10 minutes/, 600);
  f.failed("2.2.2.2"); // another address is unaffected
  now.advance(11 * MINUTE); f.failed("1.1.1.1");
});

// ============ limits inside the service ============

const mk = async (limits: Partial<Limits>, clk = clock(), providers = createStubProviders({ delayMs: 5 }), extra: Record<string, unknown> = {}) => {
  const service = newService(providers, { retryBaseMs: 5, limits: { ...TEST_LIMITS, ...limits }, now: clk, ...extra });
  const ctx = fullAccess("acct_a"); await service.grantCredits(ctx.accountId, 10_000, "t");
  return { service, ctx, clk };
};
const create = (call: Awaited<ReturnType<typeof connect>>["call"], extra: Record<string, unknown> = {}, k = key()) => call("create_ad", { prompt: "Spring deep-clean special for families", idempotency_key: k, ...extra });

await test("new ads: limited per hour with a clear wait, replays of an earlier request are free, other accounts are unaffected", async () => {
  const { service, ctx, clk } = await mk({ createAdPerHour: 3 });
  const { call } = await connect(service, ctx);
  const firstKey = key();
  const first = await create(call, {}, firstKey);
  await create(call); await create(call);
  const blocked = await create(call);
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /^\[rate_limited\] You have used all 3 new ads allowed per hour\. Try again in \d+ minutes\./);
  assert.ok(blocked.json.error.retry_after > 0);
  assert.equal((await service.listAds(ctx, 50)).length, 3, "the refused request created nothing");
  const replay = await create(call, {}, firstKey); // same key, same request: returns the original and costs nothing
  assert.equal(replay.isError, false, replay.text);
  assert.equal(replay.json.job_id, first.json.job_id);
  const other = await connect(service, fullAccess("acct_b"));
  assert.equal((await create(other.call)).isError, false);
  clk.advance(HOUR + 1000);
  assert.equal((await create(call)).isError, false, "allowed again after the hour");
});

await test("new ads: a request that fails validation still counts, so errors cannot be used to hammer the server", async () => {
  const { service, ctx } = await mk({ createAdPerHour: 3 });
  const { call } = await connect(service, ctx);
  for (let i = 0; i < 3; i++) assert.match((await create(call, { brand_kit_id: "bk_missing" })).text, /^\[not_found\]/);
  assert.match((await create(call)).text, /^\[rate_limited\]/);
});

await test("variants: counted by how many were asked for, replays are free, and asking for more than the limit is refused outright", async () => {
  const { service, ctx, clk } = await mk({ createVariantsPerHour: 10 });
  const { call } = await connect(service, ctx);
  const a = await newReadyAd(call); const b = await newReadyAd(call); // the stub only has five hook ideas per ad, so spread across two
  const k1 = key();
  assert.equal((await call("create_variants", { job_id: a, count: 5, tested_variable: "hook", idempotency_key: k1 })).isError, false);
  assert.equal((await call("create_variants", { job_id: b, count: 5, tested_variable: "hook", idempotency_key: key() })).isError, false);
  const over = await call("create_variants", { job_id: a, count: 1, tested_variable: "angle", idempotency_key: key() });
  assert.match(over.text, /^\[rate_limited\] You have used all 10 variants allowed per hour/);
  assert.equal((await service.listAds(ctx, 50)).length, 12, "the refused request created nothing");
  const replay = await call("create_variants", { job_id: a, count: 5, tested_variable: "hook", idempotency_key: k1 });
  assert.equal(replay.isError, false, "a replay is free");
  assert.equal(replay.json.variants.length, 5);
  clk.advance(HOUR + 1);
  const later = await call("create_variants", { job_id: a, count: 1, tested_variable: "hook", idempotency_key: key() });
  assert.doesNotMatch(later.text, /rate_limited/, "the hour has passed, so any refusal now is about the variants themselves, not the rate");
  const small = await mk({ createVariantsPerHour: 3 });
  const c2 = await connect(small.service, small.ctx);
  const id2 = await newReadyAd(c2.call);
  assert.match((await c2.call("create_variants", { job_id: id2, count: 5, tested_variable: "hook", idempotency_key: key() })).text, /^\[invalid_input\] That asks for more than the limit of 3 variants per hour/);
});

await test("paid actions: only confirmed spending counts; videos in progress are capped per account and freed when they finish", async () => {
  const { service, ctx } = await mk({ maxActiveJobs: 1, spendActionsPerHour: 3 }, clock(), createStubProviders({ delayMs: 120 }));
  const { call } = await connect(service, ctx);
  const a = await newReadyAd(call); const b = await newReadyAd(call); const c = await newReadyAd(call);
  const est = async (id: string) => (await call("estimate_cost", { job_id: id })).json.credits as number;
  const dry = await call("regenerate_scene", { job_id: b, scene_id: "s1", instruction: "show a family", idempotency_key: key() });
  assert.equal(dry.json.started, false, "an estimate is free and is not counted");

  assert.equal((await call("approve_and_render", { job_id: a, max_credits: await est(a), idempotency_key: key() })).isError, false);
  const held = (await service.getBalance(ctx)).held;
  const busy = await call("approve_and_render", { job_id: b, max_credits: await est(b), idempotency_key: key() });
  assert.match(busy.text, /^\[rate_limited\] 1 of your videos are being made right now, which is the most allowed at once\. Try again when one finishes\./);
  assert.equal(busy.json.error.retry_after, 30);
  assert.equal((await service.getBalance(ctx)).held, held, "nothing was reserved for the refused request");
  assert.equal((await call("get_ad_status", { job_id: b })).json.status, "awaiting_approval");
  assert.match((await call("regenerate_scene", { job_id: b, scene_id: "s1", instruction: "show a family", confirm: true, max_credits: 10, idempotency_key: key() })).text, /^\[rate_limited\].*being made right now/);

  await waitForStatus(call, a, "completed", 10_000);
  assert.equal((await call("approve_and_render", { job_id: b, max_credits: await est(b), idempotency_key: key() })).isError, false, "free again once the first finished");
  await waitForStatus(call, b, "completed", 10_000);
  const k = key(); const estC = await est(c);
  assert.equal((await call("approve_and_render", { job_id: c, max_credits: estC, idempotency_key: k })).isError, false);
  await waitForStatus(call, c, "completed", 10_000);
  const d = await newReadyAd(call);
  assert.match((await call("approve_and_render", { job_id: d, max_credits: await est(d), idempotency_key: key() })).text, /^\[rate_limited\] You have used all 3 paid actions allowed per hour/);
  assert.equal((await call("approve_and_render", { job_id: c, max_credits: estC, idempotency_key: k })).isError, false, "replaying an earlier approval is free and returns the original");
});

await test("brand kits: creation is limited per hour, and logos still downloading are capped so the queue cannot be flooded", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c00" } }).png().toBuffer();
  const ing = new MediaIngestor({ checkUrl: () => new URL("https://x.example.com"), get: async () => { await gate; return { bytes: png, contentType: "image/png", finalUrl: "" }; } }, mkdtempSync(path.join(os.tmpdir(), "hookmint-lim-")));
  const { service, ctx, clk } = await mk({ maxPendingLogos: 2, createBrandKitPerHour: 6 }, clock(), createStubProviders({ delayMs: 5 }), { ingestor: ing });
  const { call } = await connect(service, ctx);
  const withLogo = () => call("create_brand_kit", { name: "S", logo_url: "https://cdn.example.com/l.png" });
  assert.equal((await withLogo()).isError, false); assert.equal((await withLogo()).isError, false);
  const third = await withLogo();
  assert.match(third.text, /^\[rate_limited\] 2 of your logos are still downloading/);
  assert.equal(await kitCount(service), 2, "the refused kit was not stored");
  assert.equal((await call("create_brand_kit", { name: "NoLogo" })).isError, false, "a kit with no logo is not affected by the logo cap");
  release();
  for (let i = 0; i < 100 && (await pendingLogos(service)) > 0; i++) await sleep(10);
  assert.equal((await withLogo()).isError, false, "free again once the logos finished");
  assert.equal((await call("create_brand_kit", { name: "Fifth" })).isError, false);
  assert.match((await call("create_brand_kit", { name: "Seventh" })).text, /^\[rate_limited\] You have used all 6 brand kits allowed per hour/);
  clk.advance(HOUR + 1);
  assert.equal((await call("create_brand_kit", { name: "Later" })).isError, false);
  const rules = await mk({ setBrandRulesPerHour: 2 }); const rc = await connect(rules.service, rules.ctx);
  const kit = (await rc.call("create_brand_kit", { name: "R" })).json.brand_kit_id;
  await rc.call("set_brand_rules", { brand_kit_id: kit, rules: [] }); await rc.call("set_brand_rules", { brand_kit_id: kit, rules: [] });
  assert.match((await rc.call("set_brand_rules", { brand_kit_id: kit, rules: [] })).text, /^\[rate_limited\] You have used all 2 rule changes/);
});

await test("downloads: the daily allowance applies to logos and scene media alike, per account, and failures say why without failing the ad", async () => {
  const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#080" } }).png().toBuffer();
  let fetched = 0;
  const now = clock();
  const ing = new MediaIngestor({ checkUrl: () => new URL("https://x.example.com"), get: async () => { fetched++; return { bytes: png, contentType: "image/png", finalUrl: "" }; } }, mkdtempSync(path.join(os.tmpdir(), "hookmint-quota-")), undefined, new FetchQuota({ fetchesPerDay: 2, fetchBytesPerDay: 1e9 }, now));
  const { service, ctx } = await mk({}, now, createStubProviders({ delayMs: 5 }), { ingestor: ing });
  const { call } = await connect(service, ctx);
  const kitStatus = async (id: string) => { for (let i = 0; i < 200; i++) { const k = (await call("get_brand_kit", { brand_kit_id: id })).json; if (k.logo_status !== "pending") return k; await sleep(10); } throw new Error("stuck"); };
  const make = async () => (await call("create_brand_kit", { name: "S", logo_url: "https://cdn.example.com/l.png" })).json.brand_kit_id as string;
  assert.equal((await kitStatus(await make())).logo_status, "ready");
  assert.equal((await kitStatus(await make())).logo_status, "ready");
  const third = await kitStatus(await make());
  assert.equal(third.logo_status, "failed");
  assert.match(third.logo_error, /limit of 2 downloads a day\. Try again in \d+ hours?\./);
  assert.equal(fetched, 2, "the third download was never attempted");
  const kit3 = (await call("create_brand_kit", { name: "Plain" })).json.brand_kit_id;
  assert.ok(await newReadyAd(call, { brand_kit_id: kit3 }), "ads still work");
  const other = newService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5, limits: TEST_LIMITS, ingestor: ing });
  const oc = await connect(other, fullAccess("acct_b"));
  const ok = (await oc.call("create_brand_kit", { name: "B", logo_url: "https://cdn.example.com/l.png" })).json.brand_kit_id;
  for (let i = 0; i < 200 && (await oc.call("get_brand_kit", { brand_kit_id: ok })).json.logo_status === "pending"; i++) await sleep(10);
  assert.equal((await oc.call("get_brand_kit", { brand_kit_id: ok })).json.logo_status, "ready", "another account has its own allowance");
  now.advance(DAY + 1000);
  assert.equal((await kitStatus(await make())).logo_status, "ready", "the allowance renews after a day");
});

await test("requests per minute: every tool call counts, listing tools does not, a refused call does nothing, and other accounts are separate", async () => {
  const { service, ctx, clk } = await mk({ requestsPerMinute: 5 });
  const { call, client } = await connect(service, ctx);
  for (let i = 0; i < 12; i++) await client.listTools(); // discovery is free
  for (let i = 0; i < 5; i++) assert.equal((await call("list_ads", { limit: 5 })).isError, false);
  const refused = await call("list_ads", { limit: 5 });
  assert.match(refused.text, /^\[rate_limited\] You have used all 5 requests allowed per minute\. Try again in \d+ seconds\./);
  assert.ok(refused.json.error.retry_after >= 1 && refused.json.error.retry_after <= 60);
  const before = (await service.listAds(ctx, 50)).length;
  assert.equal((await create(call)).isError, true, "a refused create_ad did not run");
  assert.equal((await service.listAds(ctx, 50)).length, before);
  const other = await connect(service, fullAccess("acct_b"));
  assert.equal((await other.call("list_ads", { limit: 5 })).isError, false);
  clk.advance(61_000);
  assert.equal((await call("list_ads", { limit: 5 })).isError, false);
});

// ============ over HTTP ============

const serve = (service: AdService, ctx = fullAccess("acct_a"), now?: () => number) => {
  const server = createApp(service, { apiKeys: new Map([["good-key", ctx]]), now }).listen(0);
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const authed = { authorization: "Bearer good-key", "content-type": "application/json" };

await test("REST: over the limit returns 429 with a Retry-After header and the same plain message", async () => {
  const { service, ctx } = await mk({ requestsPerMinute: 3 });
  const { server, base } = serve(service, ctx);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/v1/ads`, { headers: authed })).status, 200);
    const r = await fetch(`${base}/v1/ads`, { headers: authed });
    assert.equal(r.status, 429);
    const retry = Number(r.headers.get("retry-after"));
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${retry}`);
    const body = (await r.json()) as { error: { code: string; message: string; retry_after: number } };
    assert.equal(body.error.code, "rate_limited"); assert.equal(body.error.retry_after, retry);
    assert.match(body.error.message, /^You have used all 3 requests allowed per minute/);
  } finally { server.close(); }
});

await test("HTTP: failed keys and failed links from one address are limited, but valid keys and links are never locked out", async () => {
  const { service, ctx } = await mk({ authFailuresPer10Min: 3 });
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hookmint-file-")), "r.mp4"); writeFileSync(file, "fake video bytes");
  await putRender(service, "rn_test", { account_id: "acct_a", ad_id: "ad_x", path: file, bytes: 16 });
  const now = clock();
  const { server, base } = serve(service, ctx, now);
  try {
    const bad = () => fetch(`${base}/v1/ads`, { headers: { authorization: "Bearer wrong-key" } });
    for (let i = 0; i < 3; i++) assert.equal((await bad()).status, 401);
    const locked = await bad();
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    assert.equal((await fetch(`${base}/v1/ads`, { headers: authed })).status, 200, "a valid key still works while bad guesses are refused");
    const link = service.downloads.sign("acct_a", "rn_test").url.replace(/^https?:\/\/[^/]+/, base);
    assert.equal((await fetch(link)).status, 200, "a valid download link still works");
    const tampered = link.replace(/sig=[^&]+/, "sig=" + "A".repeat(43));
    assert.equal((await fetch(tampered)).status, 429, "guessing links from the same address is limited too");
    now.advance(11 * MINUTE);
    assert.equal((await bad()).status, 401, "the lockout expires; this is an ordinary refusal again");
    assert.equal((await fetch(tampered)).status, 403);
  } finally { server.close(); }
});

await test("HTTP: an expired link is not counted as a guess, because it was genuine", async () => {
  const { service, ctx } = await mk({ authFailuresPer10Min: 2 });
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hookmint-file-")), "r.mp4"); writeFileSync(file, "x");
  await putRender(service, "rn_old", { account_id: "acct_a", ad_id: "ad_x", path: file, bytes: 1 });
  const { server, base } = serve(service, ctx);
  try {
    const link = new (await import("../src/core/downloads.js")).DownloadSigner({ secret: "z".repeat(40), ttlSeconds: 1 });
    (service as unknown as { downloads: unknown }).downloads = link;
    const past = link.sign("acct_a", "rn_old", Date.now() - 10_000).url.replace(/^https?:\/\/[^/]+/, base);
    for (let i = 0; i < 5; i++) { const r = await fetch(past); assert.equal(r.status, 403); assert.match(await r.text(), /expired/); }
  } finally { server.close(); }
});

await test("configuration: HOOKMINT_LIMITS reaches the service, and a bad value stops startup before anything runs", async () => {
  const setup = createProviders({});
  assert.deepEqual(serviceOptions(setup, {}).limits, DEFAULT_LIMITS);
  const o = serviceOptions(setup, { HOOKMINT_LIMITS: '{"createAdPerHour": 2}' });
  assert.equal(o.limits!.createAdPerHour, 2);
  const service = newService(setup.providers, { ...o, now: clock(), retryBaseMs: 5 });
  assert.equal(service.limits.createAdPerHour, 2);
  assert.throws(() => serviceOptions(setup, { HOOKMINT_LIMITS: '{"createAdPerHour": 0}' }), /createAdPerHour must be a whole number/);
});

console.log(`limits passed: ${n} checks`);
process.exit(0);
