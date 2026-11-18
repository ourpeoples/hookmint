/**
 * Tests that only make sense with a real Postgres: row-level security, database privileges, locking across
 * instances, durability, and migrations. Needs HOOKMINT_TEST_DATABASE_URL (a superuser URL for a scratch database).
 * Without it the file says so and exits cleanly.
 */
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { fullAccess } from "../src/core/context.js";
import { loadConfig } from "../src/server/config.js";
import { AdError } from "../src/core/errors.js";
import { AdService } from "../src/core/service.js";
import { migrate, migrationsDir, setRolePasswords } from "../src/db/migrate.js";
import { PgStore } from "../src/db/pg-store.js";
import { verifyDatabase } from "../src/db/verify.js";
import { StoreFetchQuota } from "../src/core/shared-quota.js";
import { createStubProviders } from "../src/providers/stub.js";
import { key, roleUrl, sleep, TEST_LIMITS } from "./helpers.js";

const admin = process.env.HOOKMINT_TEST_DATABASE_URL;
if (!admin) {
  console.log("postgres tests skipped: set HOOKMINT_TEST_DATABASE_URL to a scratch database (superuser URL) to run them.");
  process.exit(0);
}

let n = 0;
/** Every store a test opens is closed when the test ends. Postgres allows only about 100 connections, and each store holds several. */
const openStores: PgStore[] = [];
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  try {
    await fn();
  } finally {
    await Promise.allSettled(openStores.splice(0).map((st) => st.close()));
  }
  n++;
  console.log("  ok", name);
};

const PW = "hookmint_test_pw"; // the password the tests give both roles
async function install(): Promise<string> {
  const schema = `hk_test_${randomBytes(5).toString("hex")}`;
  await migrate(admin!, { schema });
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`ALTER ROLE hookmint_app PASSWORD '${PW}'`);
  await c.query(`ALTER ROLE hookmint_worker PASSWORD '${PW}'`);
  await c.end();
  return schema;
}
const storeFor = (schema: string) => {
  const st = new PgStore({ appUrl: roleUrl(admin!, "hookmint_app"), workerUrl: roleUrl(admin!, "hookmint_worker"), schema, retryBaseMs: 5 });
  openStores.push(st);
  return st;
};
const serviceFor = (store: PgStore, extra: Record<string, unknown> = {}) => new AdService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5, limits: TEST_LIMITS, ...extra }, store);
/** A raw connection as one of the runtime roles, the way a bug or an attacker with the app's credentials would have it. */
async function raw(schema: string, role: "hookmint_app" | "hookmint_worker") {
  const c = new pg.Client({ connectionString: roleUrl(admin!, role), options: `-c search_path=${schema}` });
  await c.connect();
  return c;
}
async function asAdmin<T>(schema: string, fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: admin, options: `-c search_path=${schema}` });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const denied = (p: Promise<unknown>, what: string) => assert.rejects(p, (e: { code?: string }) => e.code === "42501" || /permission denied|row-level security/.test(String(e)), what);

const schema = await install();
const A = fullAccess("acct_a");
const B = fullAccess("acct_b");

await test("rls: with no account set the app role sees nothing, and with one set it sees only that account", async () => {
  const svc = serviceFor(storeFor(schema));
  await svc.grantCredits("acct_a", 100, "t");
  await svc.grantCredits("acct_b", 100, "t");
  const adA = await svc.createAd(A, { prompt: "A prompt for account a", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await svc.createAd(B, { prompt: "A prompt for account b", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await svc.idle();
  const c = await raw(schema, "hookmint_app");
  try {
    assert.equal((await c.query("SELECT count(*) AS n FROM ads")).rows[0].n, "0", "no setting, no rows");
    for (const table of ["ledger", "audit_log", "accounts", "reservations", "provider_calls", "outbox"]) assert.equal((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n, "0", `${table}: no setting, no rows`);
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    const mine = (await c.query("SELECT id, account_id FROM ads")).rows;
    assert.ok(mine.length >= 1 && mine.every((r) => r.account_id === "acct_a"));
    assert.ok(mine.some((r) => r.id === adA.id));
    assert.equal((await c.query("SELECT count(*) AS n FROM ads WHERE account_id = 'acct_b'")).rows[0].n, "0", "asking for the other account by name still returns nothing");
    assert.equal((await c.query("UPDATE ads SET prompt = 'hijacked' WHERE account_id = 'acct_b'")).rowCount, 0, "cannot change another account's rows");
    await c.query("COMMIT");
  } finally { await c.end(); }
});

await test("rls: the app role cannot write rows for another account, even with a valid-looking insert", async () => {
  const c = await raw(schema, "hookmint_app");
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await assert.rejects(c.query("INSERT INTO ledger (id, account_id, delta, reason) VALUES ('l_evil', 'acct_b', 1000000, 'gift')"), /row-level security/);
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await assert.rejects(c.query("INSERT INTO ads (id, account_id, prompt, duration_s, aspect_ratios, status, version, created_at) VALUES ('ad_evil', 'acct_b', 'x', 15, '[]', 'scripting', 1, 'now')"), /row-level security/);
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

await test("rls: the account setting lasts one transaction only, so a pooled connection never carries it to the next user", async () => {
  const store = storeFor(schema);
  const svc = serviceFor(store);
  for (let i = 0; i < 6; i++) await svc.getBalance(A);
  const c = await raw(schema, "hookmint_app");
  try {
    assert.equal((await c.query("SELECT current_setting('app.account_id', true) AS v")).rows[0].v === null || (await c.query("SELECT current_setting('app.account_id', true) AS v")).rows[0].v === "", true);
    assert.equal((await c.query("SELECT count(*) AS n FROM ads")).rows[0].n, "0");
  } finally { await c.end(); }
  await store.close();
});

await test("privileges: the ledger and the audit log cannot be changed or deleted, even by the app's own role", async () => {
  const c = await raw(schema, "hookmint_app");
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    assert.ok(Number((await c.query("SELECT count(*) AS n FROM ledger")).rows[0].n) >= 1);
    await denied(c.query("UPDATE ledger SET delta = 999999"), "ledger update");
    await c.query("ROLLBACK"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(c.query("DELETE FROM ledger"), "ledger delete");
    await c.query("ROLLBACK"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(c.query("UPDATE audit_log SET action = 'x'"), "audit update");
    await c.query("ROLLBACK"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(c.query("DELETE FROM audit_log"), "audit delete");
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

await test("privileges: the worker role sees the outbox of every account and nothing else", async () => {
  const w = await raw(schema, "hookmint_worker");
  try {
    const rows = (await w.query("SELECT DISTINCT account_id FROM outbox")).rows.map((r) => r.account_id).sort();
    assert.deepEqual(rows, ["acct_a", "acct_b"]);
    for (const t of ["ads", "ledger", "brand_kits", "audit_log", "provider_calls", "idempotency"]) await denied(w.query(`SELECT 1 FROM ${t}`), `worker reading ${t}`);
    await denied(w.query("DELETE FROM outbox"), "worker deleting outbox rows");
  } finally { await w.end(); }
  const a = await raw(schema, "hookmint_app");
  try {
    await a.query("BEGIN");
    await a.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(a.query("UPDATE outbox SET done_at = now()"), "a request marking work as done");
    await a.query("ROLLBACK");
  } finally { await a.end(); }
});

await test("service: another account's ids behave as not found, through the real database", async () => {
  const svc = serviceFor(storeFor(schema));
  const mine = await svc.createAd(A, { prompt: "Only account a can see this one", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await assert.rejects(svc.getAd(B, mine.id), (e: AdError) => e.code === "not_found");
  await assert.rejects(svc.cancelAd(B, mine.id), (e: AdError) => e.code === "not_found");
  assert.ok(!(await svc.listAds(B, 100)).some((a) => a.id === mine.id));
  await svc.idle();
});

await test("durability: a second instance sees everything the first one wrote, and finishes work the first never did", async () => {
  const s = await install();
  const one = serviceFor(storeFor(s));
  await one.grantCredits("acct_a", 50, "t");
  // Simulate a crash right after commit: the ad and its outbox row are saved, but nothing ran the work.
  const adId = await one.store.tx("acct_a", async (t) => {
    const ad = { id: "ad_crashed", account_id: "acct_a", prompt: "A prompt that was never scripted", duration_s: 15, aspect_ratios: ["9:16" as const], status: "scripting" as const, version: 1, plans: [], assets: {}, renders: [], regenerations: 0, created_at: new Date().toISOString() };
    await t.insertAd(ad);
    await t.enqueue("script", { ad_id: ad.id, version: 1 });
    return ad.id;
  });
  const two = serviceFor(storeFor(s));
  assert.equal((await two.getBalance(A)).available, 50, "credits survived");
  assert.equal((await two.getAd(A, adId)).status, "scripting");
  await two.relay();
  await two.idle();
  const done = await two.getAd(A, adId);
  assert.equal(done.status, "awaiting_approval", "the second instance finished the first one's work");
  assert.equal(done.plans.length, 1);
  assert.ok(await (async () => { const c = await asAdmin(s, (x) => x.query("SELECT count(*) AS n FROM outbox WHERE done_at IS NULL")); return c.rows[0].n === "0"; })(), "the outbox row is marked done");
});

await test("durability: a finished provider call is remembered across instances, so a retry after a restart does not pay again", async () => {
  const s = await install();
  const one = storeFor(s);
  let calls = 0;
  const first = await one.providerCalls.runOnce("acct_a:script:1", { provider: "script", cost_credits: 0 }, async () => { calls++; return { plan: "p1", n: [1, 2, 3] }; });
  const two = storeFor(s);
  const second = await two.providerCalls.runOnce("acct_a:script:1", { provider: "script", cost_credits: 0 }, async () => { calls++; return { plan: "other" }; });
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  await assert.rejects(asAdmin(s, async (c) => { await c.query("SET ROLE hookmint_app"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id','acct_b',true)"); const r = await c.query("SELECT * FROM provider_calls"); if (r.rowCount) throw new Error("leaked"); throw new Error("none visible"); }), /none visible/, "another account sees no provider calls");
});

await test("concurrency: two instances racing on one idempotency key make one ad and one charge", async () => {
  const s = await install();
  const one = serviceFor(storeFor(s));
  const two = serviceFor(storeFor(s));
  await one.grantCredits("acct_a", 500, "t");
  const k = key();
  const input = { prompt: "Racing requests with one key", duration_s: 15, aspect_ratios: ["9:16" as const], idempotency_key: k };
  const made = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).createAd(A, input)));
  assert.equal(new Set(made.map((a) => a.id)).size, 1);
  assert.equal((await one.listAds(A, 50)).length, 1);
  await one.idle(); await two.idle();
  const id = made[0].id;
  for (let i = 0; i < 100 && (await one.getAd(A, id)).status === "scripting"; i++) await sleep(20);
  const est = await one.estimateCost(A, id);
  const ak = key();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).approveAndRender(A, id, { max_credits: est.credits, idempotency_key: ak })));
  assert.ok(results.every((r) => r.status === "fulfilled"), "repeats of one approval are all answered");
  await one.idle(); await two.idle();
  for (let i = 0; i < 200 && (await one.getAd(A, id)).status !== "completed"; i++) await sleep(25);
  assert.equal((await one.getAd(A, id)).status, "completed");
  const spent = await asAdmin(s, (c) => c.query("SELECT count(*) AS n, coalesce(sum(delta),0) AS d FROM ledger WHERE account_id = 'acct_a' AND delta < 0"));
  assert.equal(spent.rows[0].n, "1", "charged exactly once");
  assert.equal(Number(spent.rows[0].d), -est.credits);
});

await test("concurrency: two different approvals cannot spend the same credits twice", async () => {
  const s = await install();
  const one = serviceFor(storeFor(s));
  const two = serviceFor(storeFor(s));
  const probe = await one.createAd(A, { prompt: "Probe ad to learn the price", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  for (let i = 0; i < 100 && (await one.getAd(A, probe.id)).status === "scripting"; i++) await sleep(20);
  const price = (await one.estimateCost(A, probe.id)).credits;
  await one.grantCredits("acct_a", price + Math.floor(price / 2), "enough for one and a half");
  const other = await two.createAd(A, { prompt: "Second ad competing for credits", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  for (let i = 0; i < 100 && (await two.getAd(A, other.id)).status === "scripting"; i++) await sleep(20);
  const results = await Promise.allSettled([
    one.approveAndRender(A, probe.id, { max_credits: price, idempotency_key: key() }),
    two.approveAndRender(A, other.id, { max_credits: price, idempotency_key: key() }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.filter((r) => r.status === "rejected" && (r.reason as AdError).code === "insufficient_credits").length;
  assert.deepEqual([ok, refused], [1, 1], "exactly one approval wins; the other is refused for lack of credits");
  await one.idle(); await two.idle();
});

await test("concurrency: a write based on a stale read is refused instead of overwriting", async () => {
  const s = await install();
  const store = storeFor(s);
  const svc = serviceFor(store);
  const ad = await svc.createAd(A, { prompt: "A prompt for a stale write test", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await svc.idle();
  const stale = await store.tx("acct_a", (t) => t.getAd(ad.id));
  const reread = await store.tx("acct_a", (t) => t.getAd(ad.id));
  await store.tx("acct_a", async (t) => { const x = (await t.lockAd(ad.id))!; x.version++; x.error = "first writer"; await t.saveAd(x); });
  await assert.rejects(store.tx("acct_a", async (t) => { await t.getAd(ad.id); const y = { ...reread!, version: reread!.version + 1, error: "second writer" }; (t as unknown as { loaded: Map<string, number> }).loaded.set(ad.id, reread!.version); await t.saveAd(y); }), (e: AdError) => e.code === "conflict");
  assert.equal((await store.tx("acct_a", (t) => t.getAd(ad.id)))!.error, "first writer");
  assert.ok(stale);
});

await test("outbox: workers claim different rows, and a claimed row comes back after its lease runs out", async () => {
  const s = await install();
  const store = storeFor(s);
  await store.tx("acct_a", async (t) => { for (let i = 0; i < 6; i++) await t.enqueue("script", { ad_id: `ad_${i}`, version: 1 }); });
  const [x, y] = await Promise.all([store.claimOutbox(3, 60_000), store.claimOutbox(3, 60_000)]);
  const ids = [...x, ...y].map((r) => r.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6, "no row was handed to two workers");
  assert.equal((await store.claimOutbox(10, 60_000)).length, 0, "claimed rows are not handed out again while leased");
  await store.completeOutbox(ids[0]);
  await asAdmin(s, (c) => c.query("UPDATE outbox SET claimed_until = now() - interval '1 second' WHERE id = $1", [ids[1]]));
  const again = await store.claimOutbox(10, 60_000);
  assert.deepEqual(again.map((r) => r.id), [ids[1]], "only the expired lease is redelivered; the finished row stays done");
});

await test("migrations: re-running does nothing, an edited migration is refused, and a failed one leaves no trace", async () => {
  const s = `hk_test_${randomBytes(5).toString("hex")}`;
  const first = await migrate(admin!, { schema: s });
  const shipped = readdirSync(migrationsDir()).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  assert.deepEqual(first, shipped, "every shipped migration is applied, in order");
  assert.deepEqual(await migrate(admin!, { schema: s }), []);
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-mig-"));
  cpSync(migrationsDir(), dir, { recursive: true });
  appendFileSync(path.join(dir, "0001_init.sql"), "\n-- edited\n");
  await assert.rejects(migrate(admin!, { schema: s, dir }), /was changed after it was applied/);
  writeFileSync(path.join(dir, "0001_init.sql"), (await import("node:fs")).readFileSync(path.join(migrationsDir(), "0001_init.sql"), "utf8"));
  writeFileSync(path.join(dir, "9999_broken.sql"), "CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;");
  await assert.rejects(migrate(admin!, { schema: s, dir }), /9999_broken.sql failed/);
  const left = await asAdmin(s, (c) => c.query("SELECT to_regclass('half_done') AS t, (SELECT count(*) FROM schema_migrations) AS n"));
  assert.equal(left.rows[0].t, null, "the failed migration was rolled back completely");
  assert.equal(left.rows[0].n, String(shipped.length));
  assert.ok(readdirSync(migrationsDir()).includes("0001_init.sql"));
});

await test("results: ad links and performance rows are tenant-isolated, append-only, and checked by the database itself", async () => {
  const s = await install();
  const svc = serviceFor(storeFor(s));
  const mkRow = (acct: string, link: string, over: Record<string, unknown> = {}) => ({ id: `sn_${randomBytes(6).toString("hex")}`, account_id: acct, link_id: link, date: "2026-05-01", spend: 1, impressions: 100, clicks: 5, conversions: 0, currency: "USD", timezone: "UTC", attribution_window: "7d_click", metric_definition_version: "m1", source: "manual" as const, created_at: "2026-05-02T00:00:00Z", ...over });
  const mkLink = (acct: string, id: string, pid: string) => ({ id, account_id: acct, ad_id: "ad_x", platform: "meta", platform_ad_id: pid, launch_mode: "separate" as const, created_at: "2026-05-01T00:00:00Z" });
  await svc.store.tx("acct_a", async (t) => { await t.putLink(mkLink("acct_a", "lk_a", "p1")); await t.appendSnapshots([mkRow("acct_a", "lk_a")]); });
  await svc.store.tx("acct_b", async (t) => { await t.putLink(mkLink("acct_b", "lk_b", "p1")); await t.appendSnapshots([mkRow("acct_b", "lk_b")]); }); // the same platform ad id in another account is fine
  assert.equal((await svc.store.tx("acct_a", (t) => t.snapshotsForLinks(["lk_a", "lk_b"]))).length, 1, "acct_a cannot read acct_b's rows even by naming the link");
  assert.equal(await svc.store.tx("acct_a", (t) => t.getLink("lk_b")), undefined);
  await assert.rejects(svc.store.tx("acct_a", (t) => t.appendSnapshots([mkRow("acct_b", "lk_b")])), "writing a row for another account is refused");
  const c = await raw(s, "hookmint_app");
  try {
    for (const table of ["ad_links", "performance_snapshots"]) assert.equal((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n, "0", `${table}: no account set, no rows`);
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    assert.equal((await c.query("SELECT count(*) AS n FROM performance_snapshots")).rows[0].n, "1");
    await denied(c.query("UPDATE performance_snapshots SET clicks = 0"), "result rows cannot be edited");
    await c.query("ROLLBACK"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(c.query("DELETE FROM performance_snapshots"), "result rows cannot be deleted");
    await c.query("ROLLBACK"); await c.query("BEGIN"); await c.query("SELECT set_config('app.account_id', 'acct_a', true)");
    await denied(c.query("UPDATE ad_links SET launch_mode = 'platform_experiment'"), "a link's launch mode cannot be rewritten after the fact");
    await c.query("ROLLBACK");
  } finally { await c.end(); }
  const check = (over: Record<string, unknown>) => svc.store.tx("acct_a", (t) => t.appendSnapshots([mkRow("acct_a", "lk_a", over)]));
  await assert.rejects(check({ clicks: 101 }), "clicks above impressions is refused by the database");
  await assert.rejects(check({ conversions: 101 }), "conversions above impressions is refused by the database");
  await assert.rejects(check({ spend: -1 }), "negative spend is refused");
  await assert.rejects(check({ date: "May 1" }), "a malformed date is refused");
  await assert.rejects(svc.store.tx("acct_a", (t) => t.putLink(mkLink("acct_a", "lk_dup", "p1"))), "one live ad cannot be linked twice in an account");
  await assert.rejects(svc.store.tx("acct_a", (t) => t.putLink({ ...mkLink("acct_a", "lk_bad", "p2"), launch_mode: "whatever" as never })), "an unknown launch mode is refused");
  const w = await raw(s, "hookmint_worker");
  try { await denied(w.query("SELECT 1 FROM performance_snapshots"), "the worker cannot read results"); await denied(w.query("SELECT 1 FROM ad_links"), "the worker cannot read links"); } finally { await w.end(); }
});

await test("results: two instances recording the same day with one idempotency key store it once", async () => {
  const s = await install();
  const one = serviceFor(storeFor(s));
  const two = serviceFor(storeFor(s));
  await one.grantCredits("acct_a", 500, "t");
  const adId = await one.store.tx("acct_a", async (t) => {
    const ad = { id: "ad_done", account_id: "acct_a", prompt: "A finished ad for the race test", duration_s: 15, aspect_ratios: ["9:16" as const], status: "completed" as const, version: 3, plans: [], assets: {}, renders: [], regenerations: 0, created_at: new Date().toISOString() };
    await t.insertAd(ad);
    return ad.id;
  });
  const link = await one.linkAd(A, adId, { platform: "meta", platform_ad_id: "race-1", launch_mode: "same_ad_set", idempotency_key: key() });
  const today = new Date().toISOString().slice(0, 10);
  const k = key();
  const input = { currency: "USD", attribution_window: "7d_click", rows: [{ date: today, impressions: 500, clicks: 12, conversions: 1, spend: 5 }], idempotency_key: k };
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).recordPerformance(A, link.link_id, input)));
  for (const a of answers) assert.deepEqual(a, answers[0], "every caller got the same answer"); // jsonb stores keys in its own order, so compare values, not text
  assert.equal((await one.store.tx("acct_a", (t) => t.snapshotsForLinks([link.link_id]))).length, 1, "one row, not ten");
  const linkTwice = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => (i % 2 ? one : two).linkAd(A, adId, { platform: "tiktok", platform_ad_id: "race-2", launch_mode: "same_ad_set", idempotency_key: key() })));
  assert.equal(linkTwice.filter((r) => r.status === "fulfilled").length, 1, "six racing attempts to link one live ad: exactly one wins");
});

await test("shared limits: two instances count the same uses, so a limit is not multiplied by the number of servers", async () => {
  const s = await install();
  const one = serviceFor(storeFor(s), { limits: { ...TEST_LIMITS, createAdPerHour: 5 } });
  const two = serviceFor(storeFor(s), { limits: { ...TEST_LIMITS, createAdPerHour: 5 } });
  const attempts = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => (i % 2 ? one : two).createAd(A, { prompt: `A prompt number ${i} for the limit test`, duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() })));
  const ok = attempts.filter((r) => r.status === "fulfilled").length;
  const refused = attempts.filter((r) => r.status === "rejected" && (r.reason as AdError).code === "rate_limited");
  assert.equal(ok, 5, "five allowed across both servers, not five each");
  assert.equal(refused.length, 9);
  assert.ok(refused.every((r) => (r as PromiseRejectedResult).reason.retry === false), "our own limit is final");
  assert.equal((await one.listAds(A, 50)).length, 5, "the refused requests created nothing");
  const rows = await asAdmin(s, (c) => c.query("SELECT count(*) AS n FROM rate_events WHERE account_id = 'acct_a' AND key = 'create_ad'"));
  assert.equal(rows.rows[0].n, "5", "a refusal records nothing");
  // another account is unaffected
  assert.equal((await two.createAd(B, { prompt: "Account b is not limited by account a", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() })).account_id, "acct_b");
  // a use counts even when the request fails after it was counted (errors cannot be used to hammer the server)
  const failing = serviceFor(storeFor(s), { limits: { ...TEST_LIMITS, createAdPerHour: 3 } });
  for (let i = 0; i < 3; i++) await assert.rejects(failing.createAd(fullAccess("acct_c"), { prompt: "A prompt for a missing brand", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key(), brand_kit_id: "bk_missing" }), (e: AdError) => e.code === "not_found");
  await assert.rejects(failing.createAd(fullAccess("acct_c"), { prompt: "A prompt for a missing brand", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() }), (e: AdError) => e.code === "rate_limited");
  await one.idle(); await two.idle();
});

await test("shared limits: the daily download allowance is one count across servers, and the counts are tenant-isolated", async () => {
  const s = await install();
  const limits = { fetchesPerDay: 3, fetchBytesPerDay: 1000 };
  const qa = new StoreFetchQuota(storeFor(s), limits);
  const qb = new StoreFetchQuota(storeFor(s), limits);
  const tries = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? qa : qb).before("acct_a")));
  assert.equal(tries.filter((r) => r.status === "fulfilled").length, 3, "three downloads a day in total");
  const refusal = tries.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(refusal.reason.message, /reached its limit of 3 downloads a day\. Try again in/);
  await qa.before("acct_b");
  const byBytes = new StoreFetchQuota(storeFor(s), { fetchesPerDay: 100, fetchBytesPerDay: 1000 });
  await byBytes.before("acct_c");
  await qa.after("acct_c", 1500);
  await assert.rejects(qb.before("acct_c"), /daily download size limit/);
  const c = await raw(s, "hookmint_app");
  try {
    assert.equal((await c.query("SELECT count(*) AS n FROM rate_events")).rows[0].n, "0", "no account set, no rows");
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.account_id', 'acct_b', true)");
    assert.equal((await c.query("SELECT count(*) AS n FROM rate_events")).rows[0].n, "1", "an account sees only its own counts");
    await c.query("ROLLBACK");
  } finally { await c.end(); }
  const w = await raw(s, "hookmint_worker");
  try { await denied(w.query("SELECT 1 FROM rate_events"), "the worker cannot read limit counts"); } finally { await w.end(); }
});

await test("pooled connections: the account setting never leaks between transactions that share one connection, even when they interleave", async () => {
  const s = await install();
  const store = new PgStore({ appUrl: roleUrl(admin!, "hookmint_app"), workerUrl: roleUrl(admin!, "hookmint_worker"), schema: s, retryBaseMs: 5, poolSize: 1 }); // one connection for everyone
  for (const acct of ["acct_a", "acct_b"]) await store.tx(acct, async (t) => { await t.addLedger({ id: `l_${acct}`, delta: 7, reason: "seed" }); });
  const seen: string[] = [];
  await Promise.all(Array.from({ length: 40 }, (_, i) => {
    const acct = i % 2 ? "acct_a" : "acct_b";
    return store.tx(acct, async (t) => {
      const mine = await t.ledger();
      if (mine.some((e) => e.account_id !== acct)) seen.push(`${acct} saw ${mine.map((e) => e.account_id).join()}`);
      await sleep(i % 3);
      assert.equal((await t.balance()), 7);
    });
  }));
  assert.deepEqual(seen, [], "no transaction ever saw another account's rows");
  const c = await raw(s, "hookmint_app"); // the same kind of connection, used with no transaction at all
  try { assert.equal((await c.query("SELECT count(*) AS n FROM ledger")).rows[0].n, "0", "a connection with no account set sees nothing"); } finally { await c.end(); }
  const probe = new PgStore({ appUrl: roleUrl(admin!, "hookmint_app"), workerUrl: roleUrl(admin!, "hookmint_worker"), schema: s, poolSize: 1 });
  await probe.tx("acct_a", async () => undefined);
  await probe.ping(); // reuses the same connection outside a transaction
  const leftover = await (probe as unknown as { app: pg.Pool }).app.query("SELECT current_setting('app.account_id', true) AS v");
  assert.ok(leftover.rows[0].v === null || leftover.rows[0].v === "", "the setting is gone once the transaction ends");
  await store.close(); await probe.close();
});

const verifyUrls = (s: string) => ({ adminUrl: admin!, appUrl: roleUrl(admin!, "hookmint_app"), workerUrl: roleUrl(admin!, "hookmint_worker"), schema: s });
async function seeded() {
  const s = await install();
  const svc = serviceFor(storeFor(s));
  await svc.grantCredits("acct_a", 100, "t");
  await svc.grantCredits("acct_b", 100, "t");
  await svc.createAd(A, { prompt: "A seeded ad for the verification test", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await svc.createAd(B, { prompt: "A seeded ad for the other account", duration_s: 15, aspect_ratios: ["9:16"], idempotency_key: key() });
  await svc.idle();
  return s;
}
const failed = (r: Awaited<ReturnType<typeof verifyDatabase>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

await test("verify: a correctly installed, used database passes every check", async () => {
  const s = await seeded();
  const r = await verifyDatabase(verifyUrls(s));
  assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.ok, true);
  assert.ok(r.checks.length >= 12, `${r.checks.length} checks ran`);
  assert.ok(r.checks.some((c) => /audit log is an unbroken chain/.test(c.name) && /entries across 2 account/.test(c.detail)));
  const empty = await install();
  assert.equal((await verifyDatabase(verifyUrls(empty))).ok, true, "a fresh database with no accounts also passes");
});

await test("verify: it notices each way the protection can be weakened or the data damaged", async () => {
  const cases: [string, string, RegExp, string?][] = [
    ["row-level security switched off", "ALTER TABLE ads DISABLE ROW LEVEL SECURITY", /row-level security is on and forced/],
    ["row-level security no longer forced", "ALTER TABLE ledger NO FORCE ROW LEVEL SECURITY", /row-level security is on and forced/],
    ["a tenant policy dropped", "DROP POLICY tenant ON brand_kits", /every such table has the tenant policy/],
    ["the application allowed to edit the ledger", "GRANT UPDATE ON ledger TO hookmint_app", /history tables cannot be changed/],
    ["the application allowed to delete audit entries", "GRANT DELETE ON audit_log TO hookmint_app", /history tables cannot be changed/],
    ["the worker allowed to read ads", "GRANT SELECT ON ads TO hookmint_worker", /worker role can reach the outbox and nothing else/],
    ["an audit entry rewritten", "UPDATE audit_log SET action = 'tampered' WHERE id = (SELECT id FROM audit_log ORDER BY seq LIMIT 1)", /audit log is an unbroken chain/],
    ["a ledger entry that overspends", "INSERT INTO ledger (id, account_id, delta, reason) VALUES ('l_bad', 'acct_a', -100000, 'oops')", /spent more than it was given/],
    ["a migration record removed", "DELETE FROM schema_migrations WHERE name = (SELECT max(name) FROM schema_migrations)", /migrations are all applied/],
    ["a migration record altered", "UPDATE schema_migrations SET checksum = 'beef' WHERE name = (SELECT min(name) FROM schema_migrations)", /match the shipped files/],
  ];
  for (const [what, sql, expected] of cases) {
    const s = await seeded();
    await asAdmin(s, (c) => c.query(sql));
    const r = await verifyDatabase(verifyUrls(s));
    assert.equal(r.ok, false, `${what}: verification should fail`);
    assert.ok(r.checks.some((c) => !c.ok && expected.test(c.name)), `${what}: expected a failed check matching ${expected}; failed: ${failed(r).join(" | ")}`);
  }
  // with row-level security off, the live probe sees the leak, not just the catalog flag
  const s = await seeded();
  await asAdmin(s, (c) => c.query("ALTER TABLE ads DISABLE ROW LEVEL SECURITY"));
  const leaky = await verifyDatabase(verifyUrls(s));
  assert.ok(leaky.checks.some((c) => !c.ok && /with no account set the application sees nothing/.test(c.name) && /ads/.test(c.detail)), "and the behavioural check catches it too");
  // a role with extra powers (roles are shared by every schema, so put it back)
  const s2 = await seeded();
  try {
    await asAdmin(s2, (c) => c.query("ALTER ROLE hookmint_app BYPASSRLS"));
    const r = await verifyDatabase(verifyUrls(s2));
    assert.ok(r.checks.some((c) => !c.ok && /role hookmint_app has no extra powers/.test(c.name) && /BYPASSRLS/.test(c.detail)));
  } finally {
    await asAdmin(s2, (c) => c.query("ALTER ROLE hookmint_app NOBYPASSRLS"));
  }
});

await test("prune: old videos are removed from disk and forgotten, recent ones and other accounts are left, and a dry run changes nothing", async () => {
  const s = await install();
  const store = storeFor(s);
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-prune-"));
  const mk = async (acct: string, id: string, ageDays: number | "gone") => {
    const file = path.join(dir, `${id}.mp4`);
    if (ageDays !== "gone") { writeFileSync(file, Buffer.alloc(2048)); const t = new Date(Date.now() - ageDays * 86_400_000); utimesSync(file, t, t); }
    await store.tx(acct, (t) => t.putRender(id, { account_id: acct, ad_id: "ad_x", path: file, bytes: 2048 }));
    return file;
  };
  const oldA = await mk("acct_a", "rn_old_a", 120);
  const newA = await mk("acct_a", "rn_new_a", 2);
  const oldB = await mk("acct_b", "rn_old_b", 200);
  const goneA = await mk("acct_a", "rn_gone_a", "gone");
  const run = (...args: string[]) => spawnSync("npx", ["tsx", "scripts/prune-renders.ts", ...args], { encoding: "utf8", env: { ...process.env, HOOKMINT_DATABASE_ADMIN_URL: admin!, HOOKMINT_DATABASE_SCHEMA: s } });
  const dry = run("--older-than-days", "90");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove rn_old_a/);
  assert.match(dry.stdout, /Would remove 3 video\(s\).*Add --yes/);
  assert.ok(existsSync(oldA) && existsSync(oldB), "a dry run removes nothing");
  assert.equal(await store.tx("acct_a", (t) => t.countRenders()), 3);
  const one = run("--older-than-days", "90", "--account", "acct_a", "--yes");
  assert.equal(one.status, 0, one.stderr);
  assert.ok(!existsSync(oldA), "the old file is gone");
  assert.ok(existsSync(newA) && existsSync(oldB), "a recent video and another account's video are untouched");
  assert.deepEqual([await store.tx("acct_a", (t) => t.countRenders()), await store.tx("acct_b", (t) => t.countRenders())], [1, 1], "acct_a keeps only the recent one; the missing-file record was cleaned up too");
  assert.equal(await store.tx("acct_a", (t) => t.getRender("rn_old_a")), undefined);
  assert.equal(await store.tx("acct_a", (t) => t.renderBytes()), 2048, "the account's stored bytes went down");
  const all = run("--older-than-days", "90", "--yes");
  assert.equal(all.status, 0, all.stderr);
  assert.ok(!existsSync(oldB));
  assert.ok(existsSync(newA));
  void goneA;
  assert.equal(run("--older-than-days", "0").status, 2, "nonsense arguments are refused");
});

await test("role passwords: applied from the environment at startup, repeatable, validated, and the roles then log in with exactly those passwords", async () => {
  const s = await install();
  const app = "app-" + randomBytes(12).toString("hex");
  const worker = "wrk-" + randomBytes(12).toString("hex");
  await setRolePasswords(admin!, { app, worker }, { schema: s });
  await setRolePasswords(admin!, { app, worker }, { schema: s }); // safe to repeat
  const as = async (role: string, pw: string) => { const u = new URL(admin!); u.username = role; u.password = pw; const c = new pg.Client({ connectionString: u.toString(), options: `-c search_path=${s}` }); await c.connect(); return c; };
  try {
    await (await as("hookmint_app", app)).end();
    await (await as("hookmint_worker", worker)).end();
    // a trust-authenticated test server accepts any password, so prove the password really changed through the catalog
    const pwdSet = await asAdmin(s, (c) => c.query("SELECT rolname, rolpassword IS NOT NULL AS has FROM pg_authid WHERE rolname IN ('hookmint_app','hookmint_worker') ORDER BY rolname"));
    assert.deepEqual(pwdSet.rows.map((r) => r.has), [true, true]);
  } finally {
    await setRolePasswords(admin!, { app: PW + "xxxxxxxx", worker: PW + "yyyyyyyy" }, { schema: s }); // back to what the other tests expect
    await asAdmin(s, (c) => c.query(`ALTER ROLE hookmint_app PASSWORD '${PW}'`));
    await asAdmin(s, (c) => c.query(`ALTER ROLE hookmint_worker PASSWORD '${PW}'`));
  }
  await assert.rejects(setRolePasswords(admin!, { app: "short", worker }, { schema: s }), /16 to 200 characters/);
  await assert.rejects(setRolePasswords(admin!, { app, worker: "has a space in it 1234567" }, { schema: s }), /no spaces/);
  const cfg = { HOOKMINT_MIGRATE_ON_START: "1", HOOKMINT_DATABASE_ADMIN_URL: "postgres://o@h/d" };
  assert.deepEqual(loadConfig({ ...cfg, HOOKMINT_APP_ROLE_PASSWORD: app, HOOKMINT_WORKER_ROLE_PASSWORD: worker }).migrateOnStart?.rolePasswords, { app, worker });
  assert.throws(() => loadConfig({ ...cfg, HOOKMINT_APP_ROLE_PASSWORD: app }), /both HOOKMINT_APP_ROLE_PASSWORD and HOOKMINT_WORKER_ROLE_PASSWORD/i);
  assert.throws(() => loadConfig({ ...cfg, HOOKMINT_APP_ROLE_PASSWORD: app, HOOKMINT_WORKER_ROLE_PASSWORD: app }), /must be different/);
  assert.throws(() => loadConfig({ HOOKMINT_APP_ROLE_PASSWORD: app, HOOKMINT_WORKER_ROLE_PASSWORD: worker }), /MIGRATE_ON_START/);
});

await test("errors: the service's own signals pass through a transaction unchanged, and a thrown error rolls everything back", async () => {
  class Signal extends Error {}
  const store = storeFor(schema);
  const marker = key();
  await assert.rejects(store.tx("acct_a", async (t) => { await t.putIdem(marker, { hash: "h", ad_id: "ad_x" }); throw new Signal("stop"); }), (e) => e instanceof Signal);
  assert.equal(await store.tx("acct_a", (t) => t.getIdem(marker)), undefined, "nothing from the failed transaction was kept");
  await store.close();
});

await test("readiness: a store reports database trouble instead of hiding it", async () => {
  const bad = new PgStore({ appUrl: "postgres://hookmint_app@127.0.0.1:1/none", workerUrl: "postgres://hookmint_worker@127.0.0.1:1/none" });
  await assert.rejects(bad.ping());
  await assert.rejects(bad.tx("acct_a", async () => 1), (e: AdError) => e.code === "provider_unavailable" && !/127\.0\.0\.1|postgres:|ECONNREFUSED/.test(e.message), "clients never see connection details");
  await bad.close();
});

console.log(`postgres: ${n} tests passed`);
process.exit(0);
