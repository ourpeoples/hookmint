import { randomUUID } from "node:crypto";
import { checkWindow, type RateEvent } from "./limits.js";
import { AdError } from "./errors.js";
import { ProviderCalls } from "./provider-calls.js";
import type { RuleSet } from "../brand/rules.js";
import {
  type Ad, type AdLink, type SnapshotRow, type AuditEntry, hashEntry, type IdemRecord, type LedgerEntry, type OutboxRow, type RenderFileRecord, type Reservation,
  type SemanticRecord, type Store, type StoredKit, type Tx, type VariantGroup,
} from "./store.js";

type Table = Map<string, unknown>;
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/**
 * State held in memory, with the same transaction rules as the database store: one transaction at a time, every
 * read scoped to the account, changes applied only if the whole transaction succeeds. For development and tests;
 * everything is lost on restart.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  readonly providerCalls: ProviderCalls;
  private tables: Record<string, Table> = {};
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(retryBaseMs?: number) {
    this.providerCalls = new ProviderCalls(retryBaseMs);
  }

  table(name: string): Table {
    return (this.tables[name] ??= new Map());
  }
  nextSeq() {
    return ++this.seq;
  }

  async tx<T>(accountId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const t = new MemoryTx(this, accountId);
      try {
        return await fn(t);
      } catch (err) {
        t.rollback();
        throw err;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async claimOutbox(limit: number, leaseMs: number): Promise<OutboxRow[]> {
    const now = Date.now();
    const out: OutboxRow[] = [];
    for (const row of this.table("outbox").values() as Iterable<OutboxRow>) {
      if (out.length >= limit) break;
      if (row.done_at || (row.claimed_until && row.claimed_until > now)) continue;
      row.claimed_until = now + leaseMs;
      out.push(copy(row));
    }
    return out;
  }
  async completeOutbox(id: string) {
    const row = this.table("outbox").get(id) as OutboxRow | undefined;
    if (row) {
      row.done_at = new Date().toISOString();
      delete row.claimed_until;
    }
  }
  async redeliver(id: string) {
    const row = this.table("outbox").get(id) as OutboxRow | undefined;
    if (row) {
      delete row.done_at;
      delete row.claimed_until;
    }
  }
  async outboxRows() {
    return [...(this.table("outbox").values() as Iterable<OutboxRow>)].map(copy);
  }
  async queueDepth() {
    const out: Record<string, number> = {};
    for (const row of this.table("outbox").values() as Iterable<OutboxRow>) if (!row.done_at) out[row.topic] = (out[row.topic] ?? 0) + 1;
    return out;
  }
  async ping() {}
  async close() {}
}

class MemoryTx implements Tx {
  enqueued = 0;
  private undo: [string, string, unknown][] = [];
  private loaded = new Map<string, number>();

  constructor(private s: MemoryStore, readonly accountId: string) {}

  rollback() {
    for (const [table, id, prev] of this.undo.reverse()) {
      if (prev === undefined) this.s.table(table).delete(id);
      else this.s.table(table).set(id, prev);
    }
    this.undo = [];
  }
  private put(table: string, id: string, value: unknown) {
    this.undo.push([table, id, this.s.table(table).get(id)]);
    this.s.table(table).set(id, copy(value));
  }
  private mine<V extends { account_id: string }>(table: string): V[] {
    return ([...this.s.table(table).values()] as V[]).filter((v) => v.account_id === this.accountId);
  }
  private one<V extends { account_id: string }>(table: string, id: string): V | undefined {
    const v = this.s.table(table).get(id) as V | undefined;
    return v && v.account_id === this.accountId ? copy(v) : undefined;
  }
  private k(key: string) {
    return `${this.accountId}\u0000${key}`;
  }

  // ads
  async getAd(id: string) {
    const ad = this.one<Ad>("ads", id);
    if (ad) this.loaded.set(id, ad.version);
    return ad;
  }
  lockAd(id: string) {
    return this.getAd(id);
  }
  async insertAd(ad: Ad) {
    if (ad.account_id !== this.accountId) throw new Error("An ad can only be created in its own account.");
    this.put("ads", ad.id, ad);
    this.loaded.set(ad.id, ad.version);
  }
  async saveAd(ad: Ad) {
    const stored = this.one<Ad>("ads", ad.id);
    if (!stored) throw new AdError("not_found", `No ad with id ${ad.id}.`);
    if (stored.version !== this.loaded.get(ad.id)) throw new AdError("conflict", "This ad was changed by another request. Try again.");
    this.put("ads", ad.id, ad);
    this.loaded.set(ad.id, ad.version);
  }
  async listAds(limit: number) {
    return this.mine<Ad>("ads").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(copy);
  }
  async countAds(statuses: Ad["status"][]) {
    return this.mine<Ad>("ads").filter((a) => statuses.includes(a.status)).length;
  }
  async adsOfBrandKit(kitId: string, status: Ad["status"]) {
    return this.mine<Ad>("ads").filter((a) => a.brand_kit_id === kitId && a.status === status).map(copy);
  }

  // brand kits and rules
  async getKit(id: string) {
    return this.one<StoredKit>("kits", id);
  }
  async putKit(kit: StoredKit) {
    if (kit.account_id !== this.accountId) throw new Error("A brand kit can only be saved in its own account.");
    this.put("kits", kit.id, kit);
  }
  async countKits() {
    return this.mine("kits").length;
  }
  async countPendingLogos() {
    return this.mine<StoredKit>("kits").filter((k) => k.logo_status === "pending").length;
  }
  async getRules(kitId: string) {
    return this.one<RuleSet>("rules", kitId);
  }
  async putRules(kitId: string, set: RuleSet) {
    if (set.account_id !== this.accountId) throw new Error("Rules can only be saved in their own account.");
    this.put("rules", kitId, set);
  }

  // idempotency
  async lockKey() {}
  async getIdem(key: string) {
    return copy(this.s.table("idem").get(this.k(key)) as IdemRecord | undefined);
  }
  async putIdem(key: string, rec: IdemRecord) {
    this.put("idem", this.k(key), rec);
  }

  // variant groups
  async getGroup(id: string) {
    return this.one<VariantGroup>("groups", id);
  }
  async putGroup(g: VariantGroup) {
    if (g.account_id !== this.accountId) throw new Error("A variant group can only be saved in its own account.");
    this.put("groups", g.id, g);
  }
  async countGroups() {
    return this.mine("groups").length;
  }

  // ad links and performance results
  async putLink(link: AdLink) {
    if (link.account_id !== this.accountId) throw new Error("A link can only be saved in its own account.");
    this.put("links", link.id, link);
  }
  async getLink(id: string) {
    return this.one<AdLink>("links", id);
  }
  async linkByPlatformAd(platform: string, platformAdId: string) {
    return this.mine<AdLink>("links").find((l) => l.platform === platform && l.platform_ad_id === platformAdId);
  }
  async linksForAds(adIds: string[]) {
    return this.mine<AdLink>("links").filter((l) => adIds.includes(l.ad_id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(copy);
  }
  async appendSnapshots(rows: SnapshotRow[]) {
    for (const r of rows) {
      if (r.account_id !== this.accountId) throw new Error("A result row can only be saved in its own account.");
      this.put("snapshots", r.id, { ...r, seq: this.s.nextSeq() });
    }
  }
  async snapshotsForLinks(linkIds: string[]) {
    return this.mine<SnapshotRow & { seq: number }>("snapshots").filter((r) => linkIds.includes(r.link_id)).sort((a, b) => a.seq - b.seq).map(({ seq: _s, ...r }) => copy(r));
  }
  async listGroups(brandKitId?: string) {
    return this.mine<VariantGroup>("groups").filter((g) => brandKitId === undefined || g.brand_kit_id === brandKitId).map(copy);
  }

  // finished files
  async getRender(id: string) {
    return this.one<RenderFileRecord>("renders", id);
  }
  async putRender(id: string, rec: RenderFileRecord) {
    if (rec.account_id !== this.accountId) throw new Error("A render can only be saved in its own account.");
    this.put("renders", id, rec);
  }
  async countRenders() {
    return this.mine("renders").length;
  }
  async renderBytes() {
    return this.mine<RenderFileRecord & { account_id: string }>("renders").reduce((n, r) => n + r.bytes, 0);
  }

  // model-based findings
  async getSemantic(key: string) {
    return copy(this.s.table("semantic").get(this.k(key)) as SemanticRecord | undefined);
  }
  async putSemantic(key: string, rec: SemanticRecord) {
    this.put("semantic", this.k(key), rec);
  }

  // credits
  async lockAccount() {}
  async ledger() {
    return this.mine<LedgerEntry>("ledger").map(copy);
  }
  async balance() {
    return this.mine<LedgerEntry>("ledger").reduce((n, e) => n + e.delta, 0);
  }
  async held() {
    return this.mine<Reservation>("reservations").filter((r) => r.status === "held").reduce((n, r) => n + r.amount, 0);
  }
  async addLedger(e: Omit<LedgerEntry, "account_id">) {
    this.put("ledger", e.id, { ...e, account_id: this.accountId });
  }
  async putReservation(r: Omit<Reservation, "account_id">) {
    this.put("reservations", r.id, { ...r, account_id: this.accountId });
  }
  async getReservation(id: string) {
    return this.one<Reservation>("reservations", id);
  }
  async reservationsForAd(adId: string) {
    return this.mine<Reservation>("reservations").filter((r) => r.ad_id === adId).map(copy);
  }
  async reservations() {
    return this.mine<Reservation>("reservations").map(copy);
  }

  // shared rate limits
  private rateKey(key: string) {
    return `${this.accountId}\u0000${key}`;
  }
  async rateEvents(key: string, windowMs: number, now: number) {
    return ((this.s.table("rate").get(this.rateKey(key)) as RateEvent[] | undefined) ?? []).filter((e) => e.t > now - windowMs).map((e) => ({ ...e }));
  }
  async takeRate(key: string, o: { limit: number; windowMs: number; weight: number; label: string; now: number }) {
    const live = await this.rateEvents(key, o.windowMs, o.now);
    checkWindow(live, o.now, o.limit, o.windowMs, o.weight, o.label);
    // Written straight to the table, not through the undo log: the use counts even if this transaction later rolls back.
    this.s.table("rate").set(this.rateKey(key), [...live, { t: o.now, w: o.weight }]);
  }
  async recordRate(key: string, weight: number, now: number) {
    const all = (this.s.table("rate").get(this.rateKey(key)) as RateEvent[] | undefined) ?? [];
    this.put("rate", this.rateKey(key), [...all.filter((e) => e.t > now - 2 * 86_400_000), { t: now, w: weight }]);
  }

  // outbox and audit
  async enqueue(topic: OutboxRow["topic"], payload: Record<string, unknown>) {
    const row: OutboxRow = { id: randomUUID(), account_id: this.accountId, topic, payload, created_at: new Date().toISOString() };
    this.put("outbox", row.id, row);
    this.enqueued++;
  }
  async audit() {
    return this.mine<AuditEntry & { seq: number }>("audit").sort((a, b) => a.seq - b.seq).map(({ seq: _s, ...e }) => copy(e));
  }
  async appendAudit(actor: string, action: string, detail: unknown) {
    const prev = (await this.audit()).at(-1)?.hash ?? "genesis";
    const at = new Date().toISOString();
    const hash = hashEntry(prev, this.accountId, actor, action, detail, at);
    const id = randomUUID();
    this.put("audit", id, { id, account_id: this.accountId, actor, action, detail, at, prev_hash: prev, hash, seq: this.s.nextSeq() });
  }
  async verifyAudit() {
    let prev = "genesis";
    for (const e of await this.audit()) {
      if (e.prev_hash !== prev || e.hash !== hashEntry(prev, this.accountId, e.actor, e.action, e.detail, e.at)) return false;
      prev = e.hash;
    }
    return true;
  }
}
