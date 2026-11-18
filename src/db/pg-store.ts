import pg from "pg";
import { AdError } from "../core/errors.js";
import { ProviderCalls, type ProviderCallRecord } from "../core/provider-calls.js";
import type { RuleSet } from "../brand/rules.js";
import {
  type Ad, type AdLink, type SnapshotRow, type AuditEntry, hashEntry, type IdemRecord, type LedgerEntry, type OutboxRow, type RenderFileRecord, type Reservation,
  type SemanticRecord, type Store, type StoredKit, type Tx, type VariantGroup,
} from "../core/store.js";
import { randomUUID } from "node:crypto";

export interface PgStoreOptions {
  /** Connects as hookmint_app. Every request's transaction runs as this role, limited by row-level security to one account. */
  appUrl: string;
  /** Connects as hookmint_worker. Used only to claim and finish outbox rows. */
  workerUrl: string;
  /** Install location for tests (a private schema). Leave unset in production. */
  schema?: string;
  retryBaseMs?: number;
  poolSize?: number;
  /** Runs once before first use. Tests use it to install a private copy of the schema. */
  prepare?: () => Promise<void>;
  /** Called with a plain-language problem when the database misbehaves. */
  onError?: (message: string) => void;
}

function isInfrastructureError(err: unknown): boolean {
  if (err instanceof AdError || !(err instanceof Error)) return false;
  const e = err as Error & { code?: unknown; errno?: unknown; syscall?: unknown; severity?: unknown };
  return err instanceof pg.DatabaseError || e.severity !== undefined || e.syscall !== undefined || e.errno !== undefined || /connection|timeout exceeded|terminated|ECONN|ENOTFOUND/i.test(err.message);
}

const isoToNum = (d: Date | null | undefined) => (d ? d.getTime() : undefined);
const json = (v: unknown) => JSON.stringify(v);
const RETRYABLE = new Set(["40001", "40P01"]); // serialization failure, deadlock

function poolFor(url: string, schema: string | undefined, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, allowExitOnIdle: true, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  // A dropped idle connection must not crash the process; the pool replaces it on the next use.
  pool.on("error", () => undefined);
  return pool;
}

/**
 * State in Postgres. Every request is one transaction that first tells the database which account it is acting for;
 * row-level security then makes every other account's rows invisible and unwritable, whatever the SQL says.
 */
export class PgStore implements Store {
  readonly kind = "postgres" as const;
  readonly providerCalls: ProviderCalls;
  private app: pg.Pool;
  private worker: pg.Pool;
  private ready?: Promise<void>;
  /** The schema this store reads and writes, when it is not the default. */
  get schema() {
    return this.opts.schema;
  }
  private init() {
    return (this.ready ??= this.opts.prepare?.() ?? Promise.resolve());
  }

  constructor(private opts: PgStoreOptions) {
    const max = opts.poolSize ?? 10;
    this.app = poolFor(opts.appUrl, opts.schema, max);
    this.worker = poolFor(opts.workerUrl, opts.schema, 2);
    this.providerCalls = new ProviderCalls(opts.retryBaseMs, 3, {
      persist: {
        load: async (key) => {
          const acct = key.split(":")[0];
          return this.tx(acct, async (t) => (t as PgTx).loadProviderCall(key));
        },
        save: async (rec) => {
          const acct = rec.call_key.split(":")[0];
          await this.tx(acct, async (t) => (t as PgTx).saveProviderCall(rec));
        },
      },
    });
  }

  async tx<T>(accountId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    if (!accountId || accountId.includes("\u0000")) throw new Error("A transaction needs an account id.");
    await this.init();
    for (let attempt = 1; ; attempt++) {
      let client: pg.PoolClient;
      try {
        client = await this.app.connect();
      } catch (err) {
        throw this.translate(err); // an unreachable database must not leak its address to a client
      }
      try {
        await client.query("BEGIN");
        // The third argument makes the setting last only until this transaction ends, so it can never leak to the next user of the connection.
        await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        const t = new PgTx(client, accountId);
        const out = await fn(t);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE.has(code) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
          continue;
        }
        throw this.translate(err);
      } finally {
        client.release();
      }
    }
  }

  /** Database errors become plain AdErrors, so a client never sees SQL, table names or connection details. */
  private translate(err: unknown): unknown {
    // Only database and connection trouble is translated. Our own errors, including the "this work was superseded"
    // signal the service throws inside a transaction, pass through untouched.
    if (!isInfrastructureError(err)) return err;
    const code = (err as { code?: string }).code;
    this.opts.onError?.(`database error ${code ?? ""}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    if (code === "23505") return new AdError("conflict", "This was changed by another request. Try again.");
    return new AdError("provider_unavailable", "The database is temporarily unavailable. Try again shortly.");
  }

  async claimOutbox(limit: number, leaseMs: number): Promise<OutboxRow[]> {
    await this.init();
    const r = await this.worker.query(
      `UPDATE outbox SET claimed_until = now() + ($2 * interval '1 millisecond')
       WHERE id IN (SELECT id FROM outbox WHERE done_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, account_id, topic, payload, created_at, done_at, claimed_until`,
      [limit, leaseMs],
    );
    return r.rows.map(outboxRow);
  }
  async completeOutbox(id: string) {
    await this.init();
    await this.worker.query("UPDATE outbox SET done_at = now(), claimed_until = NULL WHERE id = $1", [id]);
  }
  async redeliver(id: string) {
    await this.init();
    await this.worker.query("UPDATE outbox SET done_at = NULL, claimed_until = NULL WHERE id = $1", [id]);
  }
  async outboxRows(): Promise<OutboxRow[]> {
    await this.init();
    return (await this.worker.query("SELECT id, account_id, topic, payload, created_at, done_at, claimed_until FROM outbox ORDER BY created_at, id")).rows.map(outboxRow);
  }
  async ping() {
    await this.init();
    await this.app.query("SELECT 1");
  }
  async close() {
    await Promise.allSettled([this.app.end(), this.worker.end()]);
  }
}

function outboxRow(r: { id: string; account_id: string; topic: OutboxRow["topic"]; payload: Record<string, unknown>; created_at: Date; done_at: Date | null; claimed_until: Date | null }): OutboxRow {
  return { id: r.id, account_id: r.account_id, topic: r.topic, payload: r.payload, created_at: r.created_at.toISOString(), done_at: r.done_at?.toISOString(), claimed_until: isoToNum(r.claimed_until) };
}

type AdRow = { id: string; account_id: string; brand_kit_id: string | null; prompt: string; duration_s: number; aspect_ratios: Ad["aspect_ratios"]; status: Ad["status"]; version: number; plans: Ad["plans"]; assets: Ad["assets"]; renders: Ad["renders"]; regenerations: number; variant_of: string | null; error: string | null; created_at: string };
const AD_COLUMNS = "id, account_id, brand_kit_id, prompt, duration_s, aspect_ratios, status, version, plans, assets, renders, regenerations, variant_of, error, created_at";
function toAd(r: AdRow): Ad {
  const ad: Ad = { id: r.id, account_id: r.account_id, prompt: r.prompt, duration_s: r.duration_s, aspect_ratios: r.aspect_ratios, status: r.status, version: r.version, plans: r.plans, assets: r.assets, renders: r.renders, regenerations: r.regenerations, created_at: r.created_at };
  if (r.brand_kit_id) ad.brand_kit_id = r.brand_kit_id;
  if (r.variant_of) ad.variant_of = r.variant_of;
  if (r.error) ad.error = r.error;
  return ad;
}

class PgTx implements Tx {
  enqueued = 0;
  private loaded = new Map<string, number>();
  constructor(private c: pg.PoolClient, readonly accountId: string) {}

  private async q<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    return (await this.c.query<R>(sql, params)).rows;
  }

  // ads
  private async readAd(id: string, lock: boolean) {
    const [row] = await this.q<AdRow>(`SELECT ${AD_COLUMNS} FROM ads WHERE id = $1 AND account_id = $2${lock ? " FOR UPDATE" : ""}`, [id, this.accountId]);
    if (!row) return undefined;
    this.loaded.set(id, row.version);
    return toAd(row);
  }
  getAd(id: string) {
    return this.readAd(id, false);
  }
  lockAd(id: string) {
    return this.readAd(id, true);
  }
  async insertAd(ad: Ad) {
    await this.q(
      `INSERT INTO ads (${AD_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ad.id, ad.account_id, ad.brand_kit_id ?? null, ad.prompt, ad.duration_s, json(ad.aspect_ratios), ad.status, ad.version, json(ad.plans), json(ad.assets), json(ad.renders), ad.regenerations, ad.variant_of ?? null, ad.error ?? null, ad.created_at],
    );
    this.loaded.set(ad.id, ad.version);
  }
  async saveAd(ad: Ad) {
    const was = this.loaded.get(ad.id);
    if (was === undefined) throw new Error("An ad must be read before it is saved.");
    const r = await this.c.query(
      `UPDATE ads SET status=$3, version=$4, plans=$5, assets=$6, renders=$7, regenerations=$8, error=$9 WHERE id=$1 AND account_id=$2 AND version=$10`,
      [ad.id, this.accountId, ad.status, ad.version, json(ad.plans), json(ad.assets), json(ad.renders), ad.regenerations, ad.error ?? null, was],
    );
    if (r.rowCount === 0) throw new AdError("conflict", "This ad was changed by another request. Try again.");
    this.loaded.set(ad.id, ad.version);
  }
  async listAds(limit: number) {
    return (await this.q<AdRow>(`SELECT ${AD_COLUMNS} FROM ads WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [this.accountId, limit])).map(toAd);
  }
  async countAds(statuses: Ad["status"][]) {
    const [r] = await this.q<{ n: string }>("SELECT count(*) AS n FROM ads WHERE account_id = $1 AND status = ANY($2)", [this.accountId, statuses]);
    return Number(r.n);
  }
  async adsOfBrandKit(kitId: string, status: Ad["status"]) {
    return (await this.q<AdRow>(`SELECT ${AD_COLUMNS} FROM ads WHERE account_id = $1 AND brand_kit_id = $2 AND status = $3`, [this.accountId, kitId, status])).map(toAd);
  }

  // brand kits and rules
  async getKit(id: string) {
    const [r] = await this.q<{ data: StoredKit }>("SELECT data FROM brand_kits WHERE id = $1 AND account_id = $2", [id, this.accountId]);
    return r?.data;
  }
  async putKit(kit: StoredKit) {
    await this.q(
      `INSERT INTO brand_kits (id, account_id, logo_status, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET logo_status = EXCLUDED.logo_status, data = EXCLUDED.data WHERE brand_kits.account_id = EXCLUDED.account_id`,
      [kit.id, kit.account_id, kit.logo_status, json(kit)],
    );
  }
  async countKits() {
    return Number((await this.q<{ n: string }>("SELECT count(*) AS n FROM brand_kits WHERE account_id = $1", [this.accountId]))[0].n);
  }
  async countPendingLogos() {
    return Number((await this.q<{ n: string }>("SELECT count(*) AS n FROM brand_kits WHERE account_id = $1 AND logo_status = 'pending'", [this.accountId]))[0].n);
  }
  async getRules(kitId: string) {
    const [r] = await this.q<{ data: RuleSet }>("SELECT data FROM brand_rules WHERE kit_id = $1 AND account_id = $2", [kitId, this.accountId]);
    return r?.data;
  }
  async putRules(kitId: string, set: RuleSet) {
    await this.q(
      `INSERT INTO brand_rules (kit_id, account_id, version, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (kit_id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data WHERE brand_rules.account_id = EXCLUDED.account_id`,
      [kitId, set.account_id, set.version, json(set)],
    );
  }

  // idempotency
  async lockKey(key: string) {
    await this.q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.accountId}\u0001${key}`]);
  }
  async getIdem(key: string) {
    const [r] = await this.q<{ hash: string; ad_id: string; group_id: string | null; result_ad_ids: string[] | null; result: unknown }>("SELECT hash, ad_id, group_id, result_ad_ids, result FROM idempotency WHERE account_id = $1 AND key = $2", [this.accountId, key]);
    if (!r) return undefined;
    const rec: IdemRecord = { hash: r.hash, ad_id: r.ad_id };
    if (r.group_id) rec.group_id = r.group_id;
    if (r.result_ad_ids) rec.result_ad_ids = r.result_ad_ids;
    if (r.result !== null && r.result !== undefined) rec.result = r.result;
    return rec;
  }
  async putIdem(key: string, rec: IdemRecord) {
    await this.q(
      `INSERT INTO idempotency (account_id, key, hash, ad_id, group_id, result_ad_ids, result) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, key) DO UPDATE SET hash = EXCLUDED.hash, ad_id = EXCLUDED.ad_id, group_id = EXCLUDED.group_id, result_ad_ids = EXCLUDED.result_ad_ids, result = EXCLUDED.result`,
      [this.accountId, key, rec.hash, rec.ad_id, rec.group_id ?? null, rec.result_ad_ids ? json(rec.result_ad_ids) : null, rec.result === undefined ? null : json(rec.result)],
    );
  }

  // variant groups
  async getGroup(id: string) {
    const [r] = await this.q<{ data: VariantGroup }>("SELECT data FROM variant_groups WHERE id = $1 AND account_id = $2", [id, this.accountId]);
    return r?.data;
  }
  async putGroup(g: VariantGroup) {
    await this.q(
      `INSERT INTO variant_groups (id, account_id, data) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data WHERE variant_groups.account_id = EXCLUDED.account_id`,
      [g.id, g.account_id, json(g)],
    );
  }
  async countGroups() {
    return Number((await this.q<{ n: string }>("SELECT count(*) AS n FROM variant_groups WHERE account_id = $1", [this.accountId]))[0].n);
  }

  // ad links and performance results
  async putLink(link: AdLink) {
    await this.q(
      `INSERT INTO ad_links (id, account_id, ad_id, aspect_ratio, platform, platform_ad_id, launch_mode, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [link.id, link.account_id, link.ad_id, link.aspect_ratio ?? null, link.platform, link.platform_ad_id, link.launch_mode, link.created_at],
    );
  }
  private toLink(r: { id: string; account_id: string; ad_id: string; aspect_ratio: string | null; platform: string; platform_ad_id: string; launch_mode: AdLink["launch_mode"]; created_at: string }): AdLink {
    const link: AdLink = { id: r.id, account_id: r.account_id, ad_id: r.ad_id, platform: r.platform, platform_ad_id: r.platform_ad_id, launch_mode: r.launch_mode, created_at: r.created_at };
    if (r.aspect_ratio) link.aspect_ratio = r.aspect_ratio;
    return link;
  }
  async getLink(id: string) {
    const [r] = await this.q<Parameters<PgTx["toLink"]>[0]>("SELECT * FROM ad_links WHERE id = $1 AND account_id = $2", [id, this.accountId]);
    return r ? this.toLink(r) : undefined;
  }
  async linkByPlatformAd(platform: string, platformAdId: string) {
    const [r] = await this.q<Parameters<PgTx["toLink"]>[0]>("SELECT * FROM ad_links WHERE account_id = $1 AND platform = $2 AND platform_ad_id = $3", [this.accountId, platform, platformAdId]);
    return r ? this.toLink(r) : undefined;
  }
  async linksForAds(adIds: string[]) {
    if (!adIds.length) return [];
    return (await this.q<Parameters<PgTx["toLink"]>[0]>("SELECT * FROM ad_links WHERE account_id = $1 AND ad_id = ANY($2) ORDER BY created_at, id", [this.accountId, adIds])).map((r) => this.toLink(r));
  }
  async appendSnapshots(rows: SnapshotRow[]) {
    for (const r of rows) {
      await this.q(
        `INSERT INTO performance_snapshots (id, account_id, link_id, date, spend, impressions, clicks, conversions, currency, timezone, attribution_window, metric_definition_version, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [r.id, r.account_id, r.link_id, r.date, r.spend, r.impressions, r.clicks, r.conversions, r.currency, r.timezone, r.attribution_window, r.metric_definition_version, r.source, r.created_at],
      );
    }
  }
  async snapshotsForLinks(linkIds: string[]) {
    if (!linkIds.length) return [];
    const rows = await this.q<{ id: string; account_id: string; link_id: string; date: string; spend: string; impressions: string; clicks: string; conversions: string; currency: string; timezone: string; attribution_window: string; metric_definition_version: string; source: SnapshotRow["source"]; created_at: string }>(
      "SELECT id, account_id, link_id, date, spend, impressions, clicks, conversions, currency, timezone, attribution_window, metric_definition_version, source, created_at FROM performance_snapshots WHERE account_id = $1 AND link_id = ANY($2) ORDER BY seq",
      [this.accountId, linkIds],
    );
    return rows.map((r) => ({ ...r, spend: Number(r.spend), impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions) }));
  }
  async listGroups(brandKitId?: string) {
    const rows = brandKitId === undefined
      ? await this.q<{ data: VariantGroup }>("SELECT data FROM variant_groups WHERE account_id = $1", [this.accountId])
      : await this.q<{ data: VariantGroup }>("SELECT data FROM variant_groups WHERE account_id = $1 AND data->>'brand_kit_id' = $2", [this.accountId, brandKitId]);
    return rows.map((r) => r.data);
  }

  // finished files
  async getRender(id: string) {
    const [r] = await this.q<{ account_id: string; ad_id: string; path: string; bytes: string }>("SELECT account_id, ad_id, path, bytes FROM renders WHERE id = $1 AND account_id = $2", [id, this.accountId]);
    return r ? ({ account_id: r.account_id, ad_id: r.ad_id, path: r.path, bytes: Number(r.bytes) } satisfies RenderFileRecord) : undefined;
  }
  async putRender(id: string, rec: RenderFileRecord) {
    await this.q(
      `INSERT INTO renders (id, account_id, ad_id, path, bytes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, bytes = EXCLUDED.bytes WHERE renders.account_id = EXCLUDED.account_id`,
      [id, rec.account_id, rec.ad_id, rec.path, rec.bytes],
    );
  }
  async countRenders() {
    return Number((await this.q<{ n: string }>("SELECT count(*) AS n FROM renders WHERE account_id = $1", [this.accountId]))[0].n);
  }

  // model-based findings
  async getSemantic(key: string) {
    const [r] = await this.q<{ data: SemanticRecord }>("SELECT data FROM semantic_findings WHERE account_id = $1 AND key = $2", [this.accountId, key]);
    return r?.data;
  }
  async putSemantic(key: string, rec: SemanticRecord) {
    await this.q(
      `INSERT INTO semantic_findings (account_id, key, data) VALUES ($1,$2,$3)
       ON CONFLICT (account_id, key) DO UPDATE SET data = EXCLUDED.data`,
      [this.accountId, key, json(rec)],
    );
  }

  // credits
  async lockAccount() {
    await this.q("INSERT INTO accounts (account_id) VALUES ($1) ON CONFLICT DO NOTHING", [this.accountId]);
    await this.q("SELECT 1 FROM accounts WHERE account_id = $1 FOR UPDATE", [this.accountId]);
  }
  async ledger() {
    return (await this.q<LedgerEntry>("SELECT id, account_id, ad_id, delta, reason FROM ledger WHERE account_id = $1 ORDER BY created_at, id", [this.accountId])).map((r) => ({ ...r, ad_id: r.ad_id ?? undefined }));
  }
  async balance() {
    return Number((await this.q<{ n: string | null }>("SELECT coalesce(sum(delta), 0) AS n FROM ledger WHERE account_id = $1", [this.accountId]))[0].n);
  }
  async held() {
    return Number((await this.q<{ n: string | null }>("SELECT coalesce(sum(amount), 0) AS n FROM reservations WHERE account_id = $1 AND status = 'held'", [this.accountId]))[0].n);
  }
  async addLedger(e: Omit<LedgerEntry, "account_id">) {
    await this.q("INSERT INTO ledger (id, account_id, ad_id, delta, reason) VALUES ($1,$2,$3,$4,$5)", [e.id, this.accountId, e.ad_id ?? null, e.delta, e.reason]);
  }
  async putReservation(r: Omit<Reservation, "account_id">) {
    await this.q(
      `INSERT INTO reservations (id, account_id, ad_id, amount, status) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
      [r.id, this.accountId, r.ad_id, r.amount, r.status],
    );
  }
  async getReservation(id: string) {
    const [r] = await this.q<Reservation>("SELECT id, account_id, ad_id, amount, status FROM reservations WHERE id = $1 AND account_id = $2", [id, this.accountId]);
    return r;
  }
  async reservationsForAd(adId: string) {
    return this.q<Reservation>("SELECT id, account_id, ad_id, amount, status FROM reservations WHERE account_id = $1 AND ad_id = $2", [this.accountId, adId]);
  }
  async reservations() {
    return this.q<Reservation>("SELECT id, account_id, ad_id, amount, status FROM reservations WHERE account_id = $1", [this.accountId]);
  }

  // outbox and audit
  async enqueue(topic: OutboxRow["topic"], payload: Record<string, unknown>) {
    await this.q("INSERT INTO outbox (id, account_id, topic, payload) VALUES ($1,$2,$3,$4)", [randomUUID(), this.accountId, topic, json(payload)]);
    this.enqueued++;
  }
  async audit(): Promise<AuditEntry[]> {
    return this.q<AuditEntry>("SELECT id, account_id, actor, action, detail, at, prev_hash, hash FROM audit_log WHERE account_id = $1 ORDER BY seq", [this.accountId]);
  }
  async appendAudit(actor: string, action: string, detail: unknown) {
    // One writer at a time per account, so two entries can never claim the same predecessor.
    await this.q("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [`audit\u0001${this.accountId}`]);
    const [last] = await this.q<{ hash: string }>("SELECT hash FROM audit_log WHERE account_id = $1 ORDER BY seq DESC LIMIT 1", [this.accountId]);
    const prev = last?.hash ?? "genesis";
    const at = new Date().toISOString();
    const hash = hashEntry(prev, this.accountId, actor, action, detail, at);
    await this.q("INSERT INTO audit_log (id, account_id, actor, action, detail, at, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), this.accountId, actor, action, json(detail), at, prev, hash]);
  }
  async verifyAudit() {
    let prev = "genesis";
    for (const e of await this.audit()) {
      if (e.prev_hash !== prev || e.hash !== hashEntry(prev, this.accountId, e.actor, e.action, e.detail, e.at)) return false;
      prev = e.hash;
    }
    return true;
  }

  // provider call records (used by ProviderCalls)
  async loadProviderCall(key: string): Promise<ProviderCallRecord | undefined> {
    const [r] = await this.q<{ provider: string; result: unknown; cost_credits: number; latency_ms: number | null; attempts: number }>("SELECT provider, result, cost_credits, latency_ms, attempts FROM provider_calls WHERE account_id = $1 AND call_key = $2", [this.accountId, key]);
    return r ? { call_key: key, provider: r.provider, status: "done", result: r.result ?? undefined, cost_credits: r.cost_credits, latency_ms: r.latency_ms ?? undefined, attempts: r.attempts } : undefined;
  }
  async saveProviderCall(rec: ProviderCallRecord) {
    await this.q(
      `INSERT INTO provider_calls (account_id, call_key, provider, result, cost_credits, latency_ms, attempts) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, call_key) DO NOTHING`,
      [this.accountId, rec.call_key, rec.provider, rec.result === undefined ? null : json(rec.result), rec.cost_credits, rec.latency_ms ?? null, rec.attempts],
    );
  }
}
