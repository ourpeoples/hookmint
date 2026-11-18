import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { hashEntry } from "../core/store.js";
import { migrationsDir } from "./migrate.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface Verification {
  ok: boolean;
  checks: Check[];
}
export interface VerifyOptions {
  /** A user that can read the catalogs and every table (the owner or a superuser). Used to inspect, never to change. */
  adminUrl: string;
  appUrl: string;
  workerUrl: string;
  /** For tests, a private copy of the schema. */
  schema?: string;
}

const TENANT_ROLE = "hookmint_app";
const WORKER_ROLE = "hookmint_worker";
/** Tables the application may only add to, never change or delete from. */
const APPEND_ONLY = ["ledger", "audit_log", "performance_snapshots"];

async function connect(url: string, schema?: string) {
  const c = new pg.Client({ connectionString: url, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  await c.connect();
  return c;
}

/**
 * Looks at a database and says whether the protections that matter are in place and the data is intact. Read-only: it
 * writes nothing. Run it after a restore (a backup is only worth anything if the restored copy is also locked down),
 * after a deploy, or on a schedule.
 */
export async function verifyDatabase(opts: VerifyOptions): Promise<Verification> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const admin = await connect(opts.adminUrl, opts.schema);
  try {
    // 1. migrations
    const shipped = readdirSync(migrationsDir()).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    let applied: { name: string; checksum: string }[] = [];
    try {
      applied = (await admin.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;
    } catch {
      /* reported below */
    }
    const missing = shipped.filter((f) => !applied.some((a) => a.name === f));
    const changed = applied.filter((a) => {
      const file = shipped.includes(a.name) ? readFileSync(path.join(migrationsDir(), a.name), "utf8") : undefined;
      return file !== undefined && createHash("sha256").update(file).digest("hex") !== a.checksum;
    });
    add("migrations are all applied", missing.length === 0 && applied.length > 0, missing.length ? `not applied: ${missing.join(", ")}` : `${applied.length} applied`);
    add("applied migrations match the shipped files", changed.length === 0, changed.length ? `changed since applied: ${changed.map((c) => c.name).join(", ")}` : "checksums match");

    // 2. roles
    const roles = (await admin.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)", [[TENANT_ROLE, WORKER_ROLE]],
    )).rows;
    for (const name of [TENANT_ROLE, WORKER_ROLE]) {
      const r = roles.find((x) => x.rolname === name);
      if (!r) { add(`role ${name} exists`, false, "missing"); continue; }
      const bad = [r.rolsuper && "superuser", r.rolbypassrls && "BYPASSRLS", r.rolcreaterole && "CREATEROLE", r.rolcreatedb && "CREATEDB"].filter(Boolean);
      add(`role ${name} has no extra powers`, bad.length === 0, bad.length ? `it is ${bad.join(", ")}, which switches the protection off` : "plain login role");
    }

    // 3. row-level security on every table that holds an account's data
    const tables = (await admin.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'account_id' ORDER BY table_name")).rows.map((r) => r.table_name);
    const rls = (await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1)", [tables],
    )).rows;
    const policies = (await admin.query<{ tablename: string; roles: string[] }>("SELECT tablename, roles FROM pg_policies WHERE schemaname = current_schema() AND policyname = 'tenant'")).rows;
    const offRls = tables.filter((t) => { const r = rls.find((x) => x.relname === t); return !r?.relrowsecurity || !r.relforcerowsecurity; });
    const noPolicy = tables.filter((t) => !policies.some((p) => p.tablename === t && p.roles.includes(TENANT_ROLE)));
    add("row-level security is on and forced for every table with account data", tables.length > 0 && offRls.length === 0, offRls.length ? `not protected: ${offRls.join(", ")}` : `${tables.length} tables`);
    add("every such table has the tenant policy", noPolicy.length === 0, noPolicy.length ? `no tenant policy: ${noPolicy.join(", ")}` : "present");

    // 4. what each role may do
    const can = async (role: string, table: string, priv: string) => (await admin.query<{ p: boolean }>("SELECT has_table_privilege($1, $2, $3) AS p", [role, table, priv])).rows[0].p;
    const rewriters: string[] = [];
    for (const t of APPEND_ONLY.filter((x) => tables.includes(x))) for (const priv of ["UPDATE", "DELETE"]) if (await can(TENANT_ROLE, t, priv)) rewriters.push(`${t} ${priv}`);
    add("history tables cannot be changed or deleted by the application", rewriters.length === 0, rewriters.length ? `the application role can: ${rewriters.join(", ")}` : `${APPEND_ONLY.join(", ")} are insert-only`);
    const workerExtra: string[] = [];
    for (const t of tables.filter((x) => x !== "outbox")) for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) if (await can(WORKER_ROLE, t, priv)) workerExtra.push(`${t} ${priv}`);
    add("the worker role can reach the outbox and nothing else", workerExtra.length === 0, workerExtra.length ? `it can also: ${workerExtra.slice(0, 5).join(", ")}` : "outbox only");

    // 5. behaviour: connect as the application and try to see across accounts
    const app = await connect(opts.appUrl, opts.schema);
    try {
      const unset: string[] = [];
      for (const t of tables) if (Number((await app.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n) !== 0) unset.push(t);
      add("with no account set the application sees nothing", unset.length === 0, unset.length ? `visible without an account: ${unset.join(", ")}` : "every table is empty to it");
      const probe = (await admin.query<{ account_id: string }>("SELECT account_id FROM accounts LIMIT 1")).rows[0]?.account_id ?? (await admin.query<{ account_id: string }>("SELECT account_id FROM ads LIMIT 1")).rows[0]?.account_id;
      if (!probe) add("an account sees only its own rows", true, "no accounts yet, so nothing to probe");
      else {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.account_id', $1, true)", [probe]);
        const leaks: string[] = [];
        for (const t of tables) if (Number((await app.query(`SELECT count(*) AS n FROM "${t}" WHERE account_id <> $1`, [probe])).rows[0].n) !== 0) leaks.push(t);
        await app.query("ROLLBACK");
        add("an account sees only its own rows", leaks.length === 0, leaks.length ? `rows of other accounts are visible in: ${leaks.join(", ")}` : "no other account's rows visible");
      }
    } finally {
      await app.end();
    }
    const worker = await connect(opts.workerUrl, opts.schema);
    try {
      let reachedOther = "";
      for (const t of tables.filter((x) => x !== "outbox")) {
        try { await worker.query(`SELECT 1 FROM "${t}" LIMIT 1`); reachedOther = t; break; } catch { /* expected: permission denied */ }
      }
      add("the worker connection is refused every other table", reachedOther === "", reachedOther ? `it could read ${reachedOther}` : "refused");
    } finally {
      await worker.end();
    }

    // 6. the audit logs are still a chain, per account
    if (tables.includes("audit_log")) {
      const rows = (await admin.query<{ account_id: string; actor: string; action: string; detail: unknown; at: string; prev_hash: string; hash: string }>("SELECT account_id, actor, action, detail, at, prev_hash, hash FROM audit_log ORDER BY account_id, seq")).rows;
      const broken = new Set<string>();
      const last = new Map<string, string>();
      for (const e of rows) {
        const prev = last.get(e.account_id) ?? "genesis";
        if (e.prev_hash !== prev || e.hash !== hashEntry(prev, e.account_id, e.actor, e.action, e.detail, e.at)) broken.add(e.account_id);
        last.set(e.account_id, e.hash);
      }
      add("every account's audit log is an unbroken chain", broken.size === 0, broken.size ? `chain broken for ${broken.size} account(s)` : `${rows.length} entries across ${last.size} account(s)`);
    }
    // 7. money still adds up
    if (tables.includes("ledger") && tables.includes("reservations")) {
      const negative = (await admin.query<{ account_id: string }>(
        `SELECT l.account_id FROM (SELECT account_id, sum(delta) AS bal FROM ledger GROUP BY account_id) l
         LEFT JOIN (SELECT account_id, sum(amount) AS held FROM reservations WHERE status = 'held' GROUP BY account_id) r USING (account_id)
         WHERE l.bal < 0 OR l.bal - coalesce(r.held, 0) < 0`,
      )).rows;
      add("no account has spent more than it was given", negative.length === 0, negative.length ? `${negative.length} account(s) have a negative or over-held balance` : "balances are consistent");
    }
  } finally {
    await admin.end();
  }
  return { ok: checks.every((c) => c.ok), checks };
}
