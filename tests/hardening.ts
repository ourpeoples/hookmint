import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AdError } from "../src/core/errors.js";
import { createLogger, redact } from "../src/core/logger.js";
import { ProviderCalls } from "../src/core/provider-calls.js";
import { ApiKeys, bearerToken } from "../src/server/api-keys.js";
import { createApp, Lifecycle } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { evaluate, findings } from "../scripts/audit-gate.js";
import { fullAccess } from "../src/core/context.js";
import { key, setup, USING_PG } from "./helpers.js";
import { reservationsOf } from "./inspect.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};
const clock = () => { const c = { t: Date.parse("2026-06-01T00:00:00Z") }; return Object.assign(() => c.t, { advance: (ms: number) => (c.t += ms) }); };

// ============ logging ============

await test("logger: secrets are removed by field name and by shape, and output is one JSON object per line", async () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => new Date("2026-01-01T00:00:00Z") });
  log.info("hello", { authorization: "Bearer abcdefghijklmnop", note: "token hmk_abcdefghijklmnopqrstu and sk-ant-abcdefgh1234", nested: { api_key: "x", ok: 1 }, url: "https://h/files/r?acct=a&exp=1&sig=AAAAAAAAAAAAAAAAAAAA" });
  log.child({ request_id: "r1" }).warn("w", { error: new Error("boom") });
  assert.equal(lines.length, 2);
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.equal(a.time, "2026-01-01T00:00:00.000Z");
  assert.equal(a.authorization, "[redacted]");
  assert.equal(a.nested.api_key, "[redacted]");
  assert.equal(a.nested.ok, 1);
  for (const secret of ["abcdefghijklmnop", "hmk_abcdef", "sk-ant-abc", "AAAAAAAAAAAAAAAAAAAA"]) assert.ok(!lines[0].includes(secret), `leaked ${secret}`);
  assert.equal(b.request_id, "r1");
  assert.equal(b.error.message, "boom");
  assert.ok(!("stack" in b.error), "stack traces are not logged");
  const quiet = createLogger({ level: "warn", write: (l) => lines.push(l) });
  quiet.info("dropped");
  assert.equal(lines.length, 2);
  assert.equal(String(redact("x".repeat(2000))).length, 501, "long strings are cut");
});

// ============ API keys ============

await test("api keys: only digests are stored, and a key is found, expired, revoked and rotated correctly", async () => {
  const now = clock();
  const a = ApiKeys.generate("acct_a", { label: "old" }, new Date(now()));
  const b = ApiKeys.generate("acct_a", { label: "new", expires_at: new Date(now() + 3600_000).toISOString(), scopes: ["ads:read"] }, new Date(now()));
  assert.ok(a.token.startsWith("hmk_") && a.token.length > 40);
  assert.equal(a.record.sha256, createHash("sha256").update(a.token).digest("hex"));
  assert.ok(!JSON.stringify(a.record).includes(a.token), "the record never contains the key");
  const keys = new ApiKeys([a.record, b.record], now);
  assert.equal(keys.size, 2);
  const ra = keys.authenticate(a.token);
  assert.ok(ra.ok && ra.ctx.accountId === "acct_a" && ra.ctx.scopes.size > 1);
  const rb = keys.authenticate(b.token);
  assert.ok(rb.ok && [...rb.ctx.scopes].join() === "ads:read", "a key can be limited to some scopes");
  assert.deepEqual(keys.authenticate("nope"), { ok: false, reason: "unknown" });
  assert.deepEqual(keys.authenticate(""), { ok: false, reason: "unknown" });
  assert.equal(keys.authenticate("x".repeat(600)).ok, false);
  assert.ok(keys.revoke(a.record.id), "the old key is revoked once clients have moved");
  assert.deepEqual(keys.authenticate(a.token), { ok: false, reason: "revoked", keyId: a.record.id });
  assert.equal(keys.authenticate(b.token).ok, true, "the new key keeps working");
  now.advance(2 * 3600_000);
  assert.deepEqual(keys.authenticate(b.token), { ok: false, reason: "expired", keyId: b.record.id });
});

await test("api keys: bad records are refused at load, not at the first request", async () => {
  const bad = (r: object, re: RegExp) => assert.throws(() => new ApiKeys([r as never]), re);
  const good = ApiKeys.generate("acct_a").record;
  bad({ ...good, sha256: "hmk_plaintext" }, /never the key itself/);
  bad({ ...good, id: "has space" }, /id must be/);
  bad({ ...good, account_id: "" }, /account_id/);
  bad({ ...good, scopes: ["root"] }, /unknown scope "root"/);
  bad({ ...good, expires_at: "tomorrow-ish" }, /expires_at is not a valid date/);
  assert.throws(() => new ApiKeys([good, { ...good, sha256: "0".repeat(64) }]), /appears twice/);
  assert.throws(() => new ApiKeys([good, { ...ApiKeys.generate("acct_b").record, id: good.id }]), /appears twice/);
  assert.throws(() => ApiKeys.fromJson("{"), /not valid JSON/);
  assert.throws(() => ApiKeys.fromJson("{}"), /array/);
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer   abc"), "abc");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken("Bearer a b"), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

// ============ startup checks ============

await test("config: production refuses unsafe settings and lists every problem at once", async () => {
  assert.throws(() => loadConfig({ HOOKMINT_ENV: "production" }), (e: Error) => /API keys/.test(e.message) && /URL_SECRET/.test(e.message) && /memory/.test(e.message));
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-keys-"));
  const file = path.join(dir, "keys.json");
  writeFileSync(file, JSON.stringify([ApiKeys.generate("acct_a").record]));
  const ok = { HOOKMINT_ENV: "production", HOOKMINT_API_KEYS_FILE: file, HOOKMINT_URL_SECRET: "s".repeat(32), HOOKMINT_ALLOW_EPHEMERAL: "1" };
  const c = loadConfig(ok);
  assert.equal(c.production, true);
  assert.equal(c.apiKeys?.size, 1);
  assert.throws(() => loadConfig({ ...ok, HOOKMINT_URL_SECRET: "short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...ok, API_KEY: "plain", HOOKMINT_API_KEYS_FILE: "" }), /development only/);
  assert.throws(() => loadConfig({ ...ok, HOOKMINT_CORS_ORIGINS: "*" }), /exact origins/);
  assert.throws(() => loadConfig({ ...ok, HOOKMINT_CORS_ORIGINS: "app.example.com" }), /not an origin/);
  assert.throws(() => loadConfig({ ...ok, PORT: "99999" }), /PORT/);
  assert.throws(() => loadConfig({ ...ok, HOOKMINT_API_KEYS_FILE: path.join(dir, "missing.json") }), /API keys/);
  const dev = loadConfig({ API_KEY: "dev-key" });
  assert.equal(dev.apiKeys?.authenticate("dev-key").ok, true, "development still allows one plaintext key");
  assert.equal(loadConfig({}).apiKeys, undefined, "development with no key is open, as before");
});

await test("config: database settings are checked together, and a database lets production start without the demo flag", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-keys-"));
  const file = path.join(dir, "keys.json");
  writeFileSync(file, JSON.stringify([ApiKeys.generate("acct_a").record]));
  const base = { HOOKMINT_ENV: "production", HOOKMINT_API_KEYS_FILE: file, HOOKMINT_URL_SECRET: "s".repeat(32) };
  const app = "postgres://hookmint_app:x@db.example/hookmint";
  const worker = "postgres://hookmint_worker:y@db.example/hookmint";
  assert.throws(() => loadConfig(base), /database|memory/i, "production without a database or the demo flag is refused");
  const c = loadConfig({ ...base, HOOKMINT_DATABASE_URL: app, HOOKMINT_DATABASE_WORKER_URL: worker });
  assert.deepEqual(c.database, { appUrl: app, workerUrl: worker });
  assert.throws(() => loadConfig({ ...base, HOOKMINT_DATABASE_URL: app }), /both HOOKMINT_DATABASE_URL/);
  assert.throws(() => loadConfig({ ...base, HOOKMINT_DATABASE_URL: app, HOOKMINT_DATABASE_WORKER_URL: app }), /different roles/);
  assert.throws(() => loadConfig({ ...base, HOOKMINT_DATABASE_URL: "mysql://x", HOOKMINT_DATABASE_WORKER_URL: worker }), /postgres:\/\//);
  assert.throws(() => loadConfig({ HOOKMINT_MIGRATE_ON_START: "1" }), /ADMIN_URL/);
  assert.deepEqual(loadConfig({ HOOKMINT_MIGRATE_ON_START: "1", HOOKMINT_DATABASE_ADMIN_URL: "postgres://o@h/d" }).migrateOnStart, { adminUrl: "postgres://o@h/d" });
});

await test("credits: starter credits are granted once, however many times or places the server starts", async () => {
  const { service } = await setup({}, {}, 0);
  assert.equal(await service.grantStarterCredits("acct_new", 40, "starter"), true);
  assert.equal(await service.grantStarterCredits("acct_new", 40, "starter"), false);
  const both = await Promise.all([service.grantStarterCredits("acct_race", 40, "starter"), service.grantStarterCredits("acct_race", 40, "starter")]);
  assert.deepEqual(both.sort(), [false, true]);
  assert.equal((await service.getBalance(fullAccess("acct_new"))).available, 40);
  assert.equal((await service.getBalance(fullAccess("acct_race"))).available, 40);
});

// ============ provider deadlines and circuit breaker ============

await test("provider calls: a hung provider times out as provider_unavailable and a retry can succeed", async () => {
  const pc = new ProviderCalls(1, 3, { timeoutMs: 30 });
  let calls = 0;
  const r = await pc.runOnce("k1", { provider: "p", cost_credits: 0 }, async () => {
    if (++calls === 1) await new Promise(() => {});
    return "fine";
  });
  assert.equal(r, "fine");
  assert.equal(calls, 2);
  const slow = new ProviderCalls(1, 1, { timeoutMs: 20 });
  await assert.rejects(slow.runOnce("k2", { provider: "p", cost_credits: 0 }, () => new Promise(() => {})), (e: AdError) => e.code === "provider_unavailable" && /did not answer/.test(e.message));
});

await test("provider calls: repeated failures open the breaker, calls are refused fast, one probe closes it again", async () => {
  const now = clock();
  const pc = new ProviderCalls(1, 1, { breakerThreshold: 3, breakerCooldownMs: 10_000, now });
  const fail = () => { throw new AdError("provider_unavailable", "down"); };
  for (let i = 0; i < 3; i++) await assert.rejects(pc.runOnce(`f${i}`, { provider: "p", cost_credits: 0 }, async () => fail()));
  assert.equal(pc.breakerState("p"), "open");
  assert.deepEqual(pc.openBreakers(), ["p"]);
  let ran = false;
  await assert.rejects(pc.runOnce("blocked", { provider: "p", cost_credits: 0 }, async () => { ran = true; }), (e: AdError) => e.code === "provider_unavailable" && e.retry === false && e.retry_after! >= 1);
  assert.equal(ran, false, "an open breaker does not call the provider");
  assert.equal((await pc.runOnce("other", { provider: "q", cost_credits: 0 }, async () => "ok")), "ok", "other providers are unaffected");
  now.advance(10_001);
  assert.equal(pc.breakerState("p"), "half-open");
  assert.equal(await pc.runOnce("probe", { provider: "p", cost_credits: 0 }, async () => "back"), "back");
  assert.equal(pc.breakerState("p"), "closed");
});

await test("provider calls: bad requests and our own limits never open a breaker", async () => {
  const pc = new ProviderCalls(1, 1, { breakerThreshold: 2 });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(pc.runOnce(`b${i}`, { provider: "p", cost_credits: 0 }, async () => { throw new AdError("invalid_input", "bad"); }));
    await assert.rejects(pc.runOnce(`l${i}`, { provider: "p", cost_credits: 0 }, async () => { throw new AdError("rate_limited", "ours", 60, { retry: false }); }));
  }
  assert.equal(pc.breakerState("p"), "closed");
});

// ============ HTTP ============

const serve = async (opts: Parameters<typeof createApp>[1] = {}, svc?: Awaited<ReturnType<typeof setup>>) => {
  svc ??= await setup();
  const server = createApp(svc.service, { apiKeys: new Map([["good-key", svc.ctx]]), ...opts }).listen(0);
  return { ...svc, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const auth = { authorization: "Bearer good-key" };
const json = { ...auth, "content-type": "application/json" };

await test("HTTP: security headers, a request id, and no secrets in the access log", async () => {
  const lines: string[] = [];
  const { server, base } = await serve({ logger: createLogger({ write: (l) => lines.push(l) }), hsts: true });
  try {
    const r = await fetch(`${base}/v1/ads?sig=SECRETSECRETSECRETSECRET`, { headers: { ...auth, "x-request-id": "my-trace-id-1" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-request-id"), "my-trace-id-1");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.match(r.headers.get("strict-transport-security")!, /max-age=/);
    const made = await fetch(`${base}/v1/ads`, { headers: { ...auth, "x-request-id": "bad id\twith junk" } });
    assert.match(made.headers.get("x-request-id")!, /^req_[0-9a-f]{16}$/, "an unusable inbound id is replaced");
    await new Promise((r) => setTimeout(r, 20));
    const log = JSON.parse(lines[0]);
    assert.equal(log.request_id, "my-trace-id-1");
    assert.equal(log.path, "/v1/ads");
    assert.equal(log.status, 200);
    assert.equal(log.account, "acct_a");
    assert.ok(!lines.join("").includes("SECRETSECRET"), "query strings are never logged");
  } finally { server.close(); }
});

await test("HTTP: bodies over the limit get 413 before they are parsed, and the wrong content type gets 415", async () => {
  const { server, base } = await serve({ maxBodyBytes: 2048 });
  try {
    const url = `${base}/v1/ads`;
    const headers = { ...json, "idempotency-key": key() };
    const big = await fetch(url, { method: "POST", headers, body: JSON.stringify({ prompt: "x".repeat(5000) }) });
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as { error: { code: string } }).error.code, "payload_too_large");
    // no Content-Length (chunked): the running total is what catches it
    const chunked = await fetch(url, { method: "POST", headers, body: new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("a".repeat(1000))); c.close(); } }), duplex: "half" } as RequestInit);
    assert.equal(chunked.status, 413);
    const wrong = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "text/plain", "idempotency-key": key() }, body: JSON.stringify({ prompt: "a prompt long enough" }) });
    assert.equal(wrong.status, 415);
    const fine = await fetch(url, { method: "POST", headers, body: JSON.stringify({ prompt: "a prompt that is long enough", duration_s: 15 }) });
    assert.equal(fine.status, 201);
    const ct = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json; charset=utf-8", "idempotency-key": key() }, body: JSON.stringify({ prompt: "another prompt long enough" }) });
    assert.equal(ct.status, 201, "a charset parameter is fine");
  } finally { server.close(); }
});

await test("HTTP: cross-origin access is an exact allow-list; preflight works for it and is refused for others", async () => {
  const throwaway = (await setup()).service;
  assert.throws(() => createApp(throwaway, { corsOrigins: ["*"] }), /not allowed/);
  const { server, base } = await serve({ corsOrigins: ["https://app.example.com"] });
  try {
    const ok = await fetch(`${base}/v1/ads`, { headers: { ...auth, origin: "https://app.example.com" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(ok.headers.get("vary"), "Origin");
    const other = await fetch(`${base}/v1/ads`, { headers: { ...auth, origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(`${base}/v1/ads`, { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers")!, /idempotency-key/);
    assert.equal((await fetch(`${base}/v1/ads`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(`${base}/v1/ads`, { method: "OPTIONS" })).status, 403);
  } finally { server.close(); }
});

await test("HTTP: /healthz and /readyz need no key, reveal nothing private, and readiness flips while draining", async () => {
  const life = new Lifecycle();
  const { server, base, service } = await serve({ lifecycle: life });
  try {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { status: "ok" });
    const r = await fetch(`${base}/readyz`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.status, "ready");
    assert.equal(body.store, USING_PG ? "postgres" : "memory", "readiness says which store is in use");
    assert.deepEqual(body.providers_paused, []);
    assert.equal((await fetch(`${base}/v1/ads`)).status, 403, "everything else still needs a key");
    service.store.providerCalls["breakers"].set("voice", { failures: 9, openedAt: Date.now() });
    assert.deepEqual(((await (await fetch(`${base}/readyz`)).json()) as { providers_paused: string[] }).providers_paused, ["voice"]);
    life.draining = true;
    const d = await fetch(`${base}/readyz`);
    assert.equal(d.status, 503);
    assert.equal(((await d.json()) as { status: string }).status, "draining");
    assert.equal((await fetch(`${base}/healthz`)).status, 200, "liveness stays up while draining");
  } finally { server.close(); }
});

await test("HTTP: an expired key is refused with a clear message", async () => {
  const now = clock();
  const k = ApiKeys.generate("acct_a", { expires_at: new Date(now() + 1000).toISOString() }, new Date(now()));
  const svc = await setup();
  const server = createApp(svc.service, { apiKeys: new ApiKeys([k.record], now), now }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/ads`, { headers: { authorization: `Bearer ${k.token}` } })).status, 200);
    now.advance(5000);
    const r = await fetch(`${base}/v1/ads`, { headers: { authorization: `Bearer ${k.token}` } });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /expired/);
  } finally { server.close(); }
});

// ============ fuzz and races ============

await test("fuzz: random and hostile requests never cause a 500, a stack trace, or a leak of the key", async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const junk = () => pick<unknown>([null, -1, 0.5, "", "a".repeat(300), [], {}, [[]], { prompt: 5 }, { prompt: "x" }, { prompt: "valid prompt text here", duration_s: "15" }, { prompt: "valid prompt text here", aspect_ratios: ["1:1:1"] }, { max_credits: -3 }, { count: 99, tested_variable: "hook" }, { rules: "no" }, { __proto__: { admin: true } }, "\u0000�", { a: { b: { c: { d: { e: {} } } } } }]);
  const paths = ["/v1/ads", "/v1/ads/ad_nope", "/v1/ads/ad_nope/approve", "/v1/ads/ad_nope/variants", "/v1/ads/%00", "/v1/ads/..%2f..%2fetc", "/v1/brand-kits/bk_nope/rules", "/v1/renders/x/download-url", "/files/abc?acct=a&exp=9&sig=zz", "/mcp", "/v1//ads", "/%", "/v1/ads/" + "a".repeat(5000)];
  const { server, base } = await serve();
  try {
    for (let i = 0; i < 150; i++) {
      const method = pick(["GET", "POST", "PUT", "DELETE", "PATCH"]);
      const body = method === "GET" || method === "DELETE" ? undefined : pick([JSON.stringify(junk()), "{not json", "", "[".repeat(2000), JSON.stringify(junk())]);
      const r = await fetch(base + pick(paths), { method, headers: { ...json, "idempotency-key": pick([key(), "", "k".repeat(500)]) }, body }).catch(() => null);
      if (!r) continue; // the client itself refused a malformed URL
      const text = await r.text();
      assert.ok(r.status < 500, `${method} -> ${r.status}: ${text.slice(0, 200)}`);
      assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(text), "no stack trace in a response");
      assert.ok(!text.includes("good-key"));
    }
  } finally { server.close(); }
});

await test("races: parallel creates with one idempotency key make one ad, and parallel approvals reserve credits once", async () => {
  const { service, ctx } = await setup({ delayMs: 5 });
  const k = key();
  const input = { prompt: "A concurrent test prompt, long enough", duration_s: 15, aspect_ratios: ["9:16" as const], idempotency_key: k };
  const ads = await Promise.all(Array.from({ length: 25 }, async () => service.createAd(ctx, input)));
  assert.equal(new Set(ads.map((a) => a.id)).size, 1, "one ad, however many simultaneous retries");
  assert.equal((await service.listAds(ctx, 100)).length, 1);
  const id = ads[0].id;
  await new Promise((r) => setTimeout(r, 300));
  const est = await service.estimateCost(ctx, id);
  const ak = key();
  const results = await Promise.allSettled(Array.from({ length: 25 }, async () => service.approveAndRender(ctx, id, { max_credits: est.credits, idempotency_key: ak })));
  assert.ok(results.every((r) => r.status === "fulfilled"), "repeats of one approval are all answered the same way");
  await new Promise((r) => setTimeout(r, 600));
  const held = (await reservationsOf(service)).filter((r) => r.ad_id === id).length;
  assert.equal(held, 1, "credits were reserved exactly once");
});

// ============ build tooling ============

await test("audit gate: fails on unlisted, expired and malformed exceptions, and passes on current ones", async () => {
  const report = { vulnerabilities: { zod: { via: [{ url: "https://github.com/advisories/GHSA-aaaa", title: "bad zod", severity: "high" }] }, "@remotion/x": { via: ["zod", { url: "https://github.com/advisories/GHSA-aaaa", title: "bad zod", severity: "high" }, { url: "https://github.com/advisories/GHSA-low", title: "minor", severity: "low" }] } } };
  const found = findings(report);
  assert.equal(found.length, 2);
  assert.deepEqual(found.find((f) => f.id === "GHSA-aaaa")!.packages, ["zod", "@remotion/x"]);
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(evaluate(report, [], now).failures.length, 1, "no exception on file");
  assert.equal(evaluate(report, [{ id: "GHSA-aaaa", reason: "unreachable", expires: "2026-12-31" }], now).failures.length, 0);
  assert.match(evaluate(report, [{ id: "GHSA-aaaa", reason: "unreachable", expires: "2026-05-31" }], now).failures[0], /expired on 2026-05-31/);
  assert.match(evaluate(report, [{ id: "GHSA-aaaa", reason: "  ", expires: "2026-12-31" }], now).failures.join(), /written reason/);
  assert.match(evaluate(report, [{ id: "GHSA-aaaa", reason: "r", expires: "soon" }], now).failures.join(), /expiry date/);
  assert.equal(evaluate(report, [{ id: "GHSA-aaaa", reason: "r", expires: "2026-12-31" }, { id: "GHSA-gone", reason: "r", expires: "2026-12-31" }], now).stale.length, 1);
  assert.equal(evaluate(report, [], now, "critical").failures.length, 0, "the level is respected");
  assert.equal(evaluate(report, [], now, "low").failures.length, 2);
  assert.throws(() => findings({}), /npm audit report/);
  assert.throws(() => evaluate(report, [], now, "bogus"), /Unknown audit level/);
});

console.log(`hardening: ${n} tests passed`);
process.exit(0);
