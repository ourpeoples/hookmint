/**
 * Tests that only make sense with a real Postgres: row-level security, database privileges, locking across
 * instances, durability, and migrations. Needs HOOKMINT_TEST_DATABASE_URL (a superuser URL for a scratch database).
 * Without it the file says so and exits cleanly.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { fullAccess } from "../src/core/context.js";
import { AdError } from "../src/core/errors.js";
import { AdService } from "../src/core/service.js";
import { migrate, migrationsDir } from "../src/db/migrate.js";
import { PgStore } from "../src/db/pg-store.js";
import { createStubProviders } from "../src/providers/stub.js";
import { key, roleUrl, sleep, TEST_LIMITS } from "./helpers.js";

const admin = process.env.HOOKMINT_TEST_DATABASE_URL;
if (!admin) {
  console.log("postgres tests skipped: set HOOKMINT_TEST_DATABASE_URL to a scratch database (superuser URL) to run them.");
  process.exit(0);
}

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

const PW = "hookmint_test_pw";
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
const storeFor = (schema: string) => new PgStore({ appUrl: roleUrl(admin!, "hookmint_app"), workerUrl: roleUrl(admin!, "hookmint_worker"), schema, retryBaseMs: 5 });
const serviceFor = (store: PgStore, extra = {}) => new AdService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5, limits: TEST_LIMITS, ...extra }, store);
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
  assert.deepEqual(first, ["0001_init.sql"]);
  assert.deepEqual(await migrate(admin!, { schema: s }), []);
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-mig-"));
  cpSync(migrationsDir(), dir, { recursive: true });
  appendFileSync(path.join(dir, "0001_init.sql"), "\n-- edited\n");
  await assert.rejects(migrate(admin!, { schema: s, dir }), /was changed after it was applied/);
  writeFileSync(path.join(dir, "0001_init.sql"), (await import("node:fs")).readFileSync(path.join(migrationsDir(), "0001_init.sql"), "utf8"));
  writeFileSync(path.join(dir, "0002_broken.sql"), "CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;");
  await assert.rejects(migrate(admin!, { schema: s, dir }), /0002_broken.sql failed/);
  const left = await asAdmin(s, (c) => c.query("SELECT to_regclass('half_done') AS t, (SELECT count(*) FROM schema_migrations) AS n"));
  assert.equal(left.rows[0].t, null, "the failed migration was rolled back completely");
  assert.equal(left.rows[0].n, "1");
  assert.ok(readdirSync(migrationsDir()).includes("0001_init.sql"));
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
