import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fullAccess } from "../src/core/context.js";
import { createLogger } from "../src/core/logger.js";
import { Registry, metrics } from "../src/core/metrics.js";
import { runWithContext, currentContext, annotate } from "../src/core/request-context.js";
import { createApp, routeLabel } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { VERSION } from "../src/version.js";
import { connect, key, newReadyAd, setup, sleep, TEST_LIMITS, waitForStatus } from "./helpers.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

await test("registry: counters, gauges and histograms render in the Prometheus text format, with labels escaped and rules enforced", async () => {
  const r = new Registry();
  const c = r.counter("demo_total", "A counter.", ["kind"]);
  c.inc({ kind: "a" });
  c.inc({ kind: "a" }, 2);
  c.inc({ kind: 'we"ird\\\nvalue' });
  c.inc({ kind: "a" }, -5); // counters never go down
  assert.equal(c.get({ kind: "a" }), 3);
  const g = r.gauge("demo_gauge", "A gauge.");
  g.set({}, 4); g.inc({}, 2); g.dec({}, 1);
  const h = r.histogram("demo_seconds", "A histogram.", ["stage"], [0.1, 1, 10]);
  for (const v of [0.05, 0.5, 0.5, 5, 50]) h.observe({ stage: "x" }, v);
  h.observe({ stage: "x" }, -1); h.observe({ stage: "x" }, NaN); // ignored
  const out = r.render();
  assert.match(out, /# HELP demo_total A counter\.\n# TYPE demo_total counter\ndemo_total\{kind="a"\} 3\n/);
  assert.match(out, /demo_total\{kind="we\\"ird\\\\\\nvalue"\} 1/, "quotes, backslashes and newlines in label values are escaped");
  assert.match(out, /# TYPE demo_gauge gauge\ndemo_gauge 5\n/);
  assert.match(out, /demo_seconds_bucket\{stage="x",le="0.1"\} 1\n/);
  assert.match(out, /demo_seconds_bucket\{stage="x",le="1"\} 3\n/, "buckets are cumulative");
  assert.match(out, /demo_seconds_bucket\{stage="x",le="10"\} 4\n/);
  assert.match(out, /demo_seconds_bucket\{stage="x",le="\+Inf"\} 5\n/);
  assert.match(out, /demo_seconds_sum\{stage="x"\} 56\.05\n/);
  assert.match(out, /demo_seconds_count\{stage="x"\} 5\n/);
  assert.deepEqual(h.snapshot({ stage: "x" }), { count: 5, sum: 56.05 });
  assert.throws(() => r.counter("demo_total", "again"), /already registered/);
  assert.throws(() => r.counter("bad name", "x"), /Bad metric name/);
  assert.throws(() => r.counter("ok_total", "x", ["le"]), /Bad label name/);
  assert.throws(() => r.histogram("h2", "x", [], [1, 1]), /increasing/);
  // a metric cannot grow without bound
  const wide = r.counter("wide_total", "x", ["v"]);
  for (let i = 0; i < 700; i++) wide.inc({ v: `v${i}` });
  assert.equal(wide.render().length - 2, 500, "at most 500 label combinations are kept");
  assert.match(r.render(), /hookmint_metrics_dropped_series_total 200\n/, "and the overflow is counted");
  wide.inc({ v: "z".repeat(500) }); // an over-long label value is cut, not stored whole
});

await test("route labels: ids become placeholders, so labels stay few and nothing private is ever a label", async () => {
  const cases: [string, string][] = [
    ["/v1/ads", "/v1/ads"], ["/v1/ads/ad_1a2b3c4d", "/v1/ads/{id}"], ["/v1/ads/ad_1a2b3c4d/approve", "/v1/ads/{id}/approve"],
    ["/v1/ads/ad_x/links", "/v1/ads/{id}/links"], ["/v1/ads/ad_x/script", "/v1/ads/{id}/script"], ["/v1/variant-groups/vg_1/compare", "/v1/variant-groups/{id}/compare"], ["/v1/ads/ad_x/scenes/s2/regenerate", "/v1/ads/{id}/scenes/{scene}/regenerate"], ["/v1/brand-kits/bk_1", "/v1/brand-kits/{id}"], ["/v1/brand-kits/bk_1/insights", "/v1/brand-kits/{id}/insights"],
    ["/v1/links/lk_9/performance", "/v1/links/{id}/performance"], ["/v1/variant-groups/vg_1/performance", "/v1/variant-groups/{id}/performance"],
    ["/files/rn_abc123", "/files/{id}"], ["/mcp", "/mcp"], ["/healthz", "/healthz"], ["/metrics", "/metrics"],
    ["/v1/ads/ad_1/unknown-action", "other"], ["/wp-admin/../../etc/passwd", "other"], ["/v1/ads/" + "a".repeat(5000), "/v1/ads/{id}"],
  ];
  for (const [path, label] of cases) assert.equal(routeLabel(path), label, path);
});

await test("request context: carried across awaits, annotated in place, and isolated between concurrent requests", async () => {
  assert.deepEqual(currentContext(), {});
  const seen: string[] = [];
  await Promise.all(["req_a", "req_b"].map((id) => runWithContext({ requestId: id }, async () => {
    await sleep(id === "req_a" ? 15 : 5);
    annotate({ accountId: `acct_${id}` });
    await sleep(5);
    seen.push(`${currentContext().requestId}:${currentContext().accountId}`);
  })));
  assert.deepEqual(seen.sort(), ["req_a:acct_req_a", "req_b:acct_req_b"]);
  assert.deepEqual(currentContext(), {}, "nothing leaks out of the request");
});

await test("the version in code matches package.json, and the metrics settings are validated", async () => {
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, VERSION);
  assert.equal(loadConfig({ HOOKMINT_METRICS_TOKEN: "t".repeat(24) }).metricsToken, "t".repeat(24));
  assert.equal(loadConfig({}).metricsToken, undefined);
  assert.throws(() => loadConfig({ HOOKMINT_METRICS_TOKEN: "short" }), /at least 24 characters/);
});

const PROMPT = "ZZ-SECRET-PROMPT-TEXT for a cleaning company in spring";
const ACCT = "acct_zz_probe_77";
const TOKEN = "m".repeat(32);

await test("/metrics: absent without a token, closed to a wrong one (which counts as a failed login), and open to the right one", async () => {
  const off = await setup();
  const s1 = createApp(off.service, { apiKeys: new Map([["k", off.ctx]]) }).listen(0);
  try { assert.equal((await fetch(`http://127.0.0.1:${(s1.address() as AddressInfo).port}/metrics`)).status, 404, "no token configured, so no endpoint"); } finally { s1.close(); }
  const on = await setup();
  const s2 = createApp(on.service, { apiKeys: new Map([["k", on.ctx]]), metricsToken: TOKEN }).listen(0);
  const base = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  try {
    const before = metrics.authFailures.get({ kind: "metrics_token" });
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer k" }, { authorization: `Basic ${TOKEN}` }] as Record<string, string>[]) assert.equal((await fetch(`${base}/metrics`, { headers })).status, 401);
    assert.equal(metrics.authFailures.get({ kind: "metrics_token" }), before + 4);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type")!, /^text\/plain; version=0\.0\.4/);
    const text = await ok.text();
    assert.match(text, /# TYPE hookmint_http_requests_total counter/);
    assert.match(text, new RegExp(`hookmint_build_info\\{version="${VERSION.replace(/\./g, "\\.")}"\\} 1`));
    assert.match(text, /hookmint_process_resident_memory_bytes \d+/);
    assert.match(text, /hookmint_queue_depth\{topic="script"\} \d+/);
    assert.notEqual((await fetch(`${base}/metrics`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, "only GET serves metrics; anything else goes through the normal credential check");
  } finally { s2.close(); }
});

await test("instrumentation: a finished ad moves the counters by exactly what happened, and nothing private reaches the output", async () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (l) => lines.push(l), level: "info" });
  const { service, ctx } = await setup({}, { logger }, 0);
  const acct = fullAccess(ACCT);
  await service.grantCredits(ACCT, 500, "t");
  const server = createApp(service, { apiKeys: new Map([["k", acct]]), metricsToken: TOKEN, logger }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { authorization: "Bearer k", "content-type": "application/json" };
  const snap = () => ({
    completed: metrics.jobs.get({ outcome: "completed" }), spent: metrics.creditsSpent.get({ kind: "approve" }), reserved: metrics.creditsReserved.get({ kind: "approve" }),
    cost: metrics.adCost.snapshot().count, costSum: metrics.adCost.snapshot().sum,
    script: metrics.stageDuration.snapshot({ stage: "script" }).count, scene: metrics.stageDuration.snapshot({ stage: "generate_scene" }).count, render: metrics.stageDuration.snapshot({ stage: "render" }).count,
    calls: ["script", "visual", "voice", "renderer"].map((p) => metrics.providerCalls.get({ provider: p, outcome: "ok" })),
    http: metrics.httpRequests.get({ method: "POST", route: "/v1/ads", status: "201" }),
  });
  try {
    const before = snap();
    const created = await fetch(`${base}/v1/ads`, { method: "POST", headers: { ...h, "idempotency-key": key(), "x-request-id": "trace-create-0001" }, body: JSON.stringify({ prompt: PROMPT, duration_s: 15, aspect_ratios: ["9:16", "1:1"] }) });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { job_id: string }).job_id;
    for (let i = 0; i < 200 && ((await (await fetch(`${base}/v1/ads/${id}`, { headers: h })).json()) as { status: string }).status !== "awaiting_approval"; i++) await sleep(10);
    const est = (await (await fetch(`${base}/v1/ads/${id}/estimate`, { headers: h })).json()) as { credits: number };
    const approve = await fetch(`${base}/v1/ads/${id}/approve`, { method: "POST", headers: { ...h, "idempotency-key": key(), "x-request-id": "trace-approve-0002" }, body: JSON.stringify({ max_credits: est.credits }) });
    assert.equal(approve.status, 202);
    for (let i = 0; i < 400 && ((await (await fetch(`${base}/v1/ads/${id}`, { headers: h })).json()) as { status: string }).status !== "completed"; i++) await sleep(10);
    await service.idle();
    const after = snap();
    assert.equal(after.completed - before.completed, 1, "one finished ad");
    assert.equal(after.reserved - before.reserved, est.credits, "credits reserved once, at approval");
    assert.equal(after.spent - before.spent, est.credits, "and the same credits settled");
    assert.equal(after.cost - before.cost, 1);
    assert.equal(after.costSum - before.costSum, est.credits, "the cost-per-ad histogram saw this ad's cost");
    assert.equal(after.script - before.script, 1);
    assert.ok(after.scene - before.scene >= 2, "one generation stage per scene");
    assert.equal(after.render - before.render, 2, "one render stage per aspect ratio");
    assert.deepEqual(after.calls.map((x, i) => x - before.calls[i] > 0), [true, true, true, true], "every provider was counted");
    assert.equal(after.http - before.http, 1, "the create request was counted under its route template");

    // logs line up across the asynchronous boundary
    const log = lines.map((l) => JSON.parse(l));
    const stage = (name: string) => log.filter((e) => e.msg === "job stage" && e.stage === name);
    assert.ok(stage("script").every((e) => e.request_id === "trace-create-0001" && e.job_id === id && e.account_id === ACCT), "the script stage carries the request that created the ad, the ad and the account");
    assert.ok(stage("generate_scene").length >= 2 && stage("generate_scene").every((e) => e.request_id === "trace-approve-0002" && e.job_id === id), "generation carries the request that approved it");
    assert.ok(stage("render").every((e) => e.request_id === "trace-approve-0002"));
    assert.ok(log.some((e) => e.msg === "request" && e.request_id === "trace-create-0001" && e.status === 201), "and the request itself is logged under the same id");

    // the output names no account, ad, prompt or credential
    const text = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    for (const secret of [ACCT, id, "ZZ-SECRET-PROMPT-TEXT", "trace-create-0001", "Bearer k", TOKEN]) assert.ok(!text.includes(secret), `the metrics output leaks ${secret}`);
    assert.match(text, /route="\/v1\/ads\/\{id\}\/approve"/);
    assert.match(text, /hookmint_jobs_total\{outcome="completed"\} \d+/);
    assert.match(text, /hookmint_queue_depth\{topic="generate"\} 0/, "nothing is waiting once the work is done");
  } finally { server.close(); }
  void ctx;
});

await test("instrumentation: failures, refusals, releases and the breaker are visible", async () => {
  // a provider that fails past its retries fails the ad and releases the reservation
  const failing = await setup({ failVisualTimes: 99 }, {}, 500);
  const { call } = await connect(failing.service, failing.ctx);
  const b = { failed: metrics.jobs.get({ outcome: "failed" }), released: metrics.creditsReleased.get(), errors: metrics.providerErrors.get({ provider: "visual", code: "provider_unavailable" }), errCalls: metrics.providerCalls.get({ provider: "visual", outcome: "error" }), reserved: metrics.creditsReserved.get({ kind: "approve" }) };
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  for (let i = 0; i < 300 && (await call("get_ad_status", { job_id: id })).json.status !== "failed"; i++) await sleep(10);
  await failing.service.idle();
  assert.equal(metrics.jobs.get({ outcome: "failed" }) - b.failed, 1);
  assert.equal(metrics.creditsReleased.get() - b.released, est, "the reservation was released");
  assert.equal(metrics.creditsReserved.get({ kind: "approve" }) - b.reserved, est);
  assert.ok(metrics.providerErrors.get({ provider: "visual", code: "provider_unavailable" }) - b.errors >= 1);
  // footage is chosen scene by scene, so the first scene's three tries are all that happen: later scenes do not spend provider calls once the ad has failed
  assert.equal(metrics.providerCalls.get({ provider: "visual", outcome: "error" }) - b.errCalls, 3, "every failed attempt of the scene that failed is counted");
  assert.equal(failing.stubs.calls.visual, 3, "and no later scene called the provider after that");
  // a second failing ad takes the failures past the breaker's threshold, and the calls it then refuses are counted separately
  const second = await newReadyAd(call);
  const est2 = (await call("estimate_cost", { job_id: second })).json.credits as number;
  await call("approve_and_render", { job_id: second, max_credits: est2, idempotency_key: key() });
  for (let i = 0; i < 300 && (await call("get_ad_status", { job_id: second })).json.status !== "failed"; i++) await sleep(10);
  await failing.service.idle();
  assert.ok(metrics.providerCalls.get({ provider: "visual", outcome: "error" }) - b.errCalls >= 5, "failed attempts keep being counted, up to the point the breaker opened");
  assert.ok(metrics.providerCalls.get({ provider: "visual", outcome: "refused_by_breaker" }) >= 1, "and the calls the breaker then refused are counted separately");
  assert.equal(metrics.breakerOpen.get({ provider: "visual" }), 1, "the breaker gauge shows it open");
  // cancelling is counted
  const c0 = metrics.jobs.get({ outcome: "cancelled" });
  const other = await newReadyAd(call);
  await call("cancel_ad", { job_id: other });
  assert.equal(metrics.jobs.get({ outcome: "cancelled" }) - c0, 1);
  // a refused request counts as a refusal, and does not move the spend counters
  const limited = await setup({}, { limits: { ...TEST_LIMITS, createAdPerHour: 1 } });
  const lc = await connect(limited.service, limited.ctx);
  const r0 = metrics.limitRefusals.get({ limit: "create_ad" });
  await lc.call("create_ad", { prompt: "The first ad is within the limit", idempotency_key: key() });
  assert.equal((await lc.call("create_ad", { prompt: "The second ad is over the limit", idempotency_key: key() })).isError, true);
  assert.equal(metrics.limitRefusals.get({ limit: "create_ad" }) - r0, 1);
  const poor = await setup({}, {}, 1);
  const pc = await connect(poor.service, poor.ctx);
  const pid = await newReadyAd(pc.call);
  const res0 = metrics.creditsReserved.get({ kind: "approve" });
  const refused = await pc.call("approve_and_render", { job_id: pid, max_credits: 999, idempotency_key: key() });
  assert.match(refused.text, /insufficient_credits/);
  assert.equal(metrics.creditsReserved.get({ kind: "approve" }), res0, "a refused approval reserved nothing, so nothing is counted");
  assert.equal(await waitForStatus(pc.call, pid, "awaiting_approval").then((x) => x.status), "awaiting_approval");
});

console.log(`metrics: ${n} tests passed`);
process.exit(0);
