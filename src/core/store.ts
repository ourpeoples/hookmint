import { createHash } from "node:crypto";
import type { Platform } from "./platforms.js";
import type { AspectRatio, BrandKit, JobStatus, ScenePlan } from "./schemas.js";
import type { ProviderCalls } from "./provider-calls.js";
import type { Finding } from "../brand/check.js";
import type { RuleSet } from "../brand/rules.js";

export interface Ad {
  id: string;
  account_id: string;
  brand_kit_id?: string;
  prompt: string;
  duration_s: number;
  aspect_ratios: AspectRatio[];
  platform?: Platform;
  status: JobStatus;
  version: number; // bumped on every transition; guards concurrent writers
  plans: ScenePlan[]; // immutable versions; last is current
  assets: Record<string, { visual_url: string; voice_url: string; visual_kind?: "image" | "video"; ai_voice?: boolean; voice_provider?: string; voice_name?: string }>;
  renders: RenderRecord[];
  regenerations: number;
  variant_of?: string; // base ad id, for ads created by create_variants
  error?: string;
  created_at: string;
}

export type LogoStatus = "none" | "pending" | "ready" | "failed" | "unavailable";

export interface StoredKit extends BrandKit {
  account_id: string;
  logo_status: LogoStatus;
  /** Server-side file path of the cleaned logo. Never shown to clients. */
  logo_path?: string;
  /** A plain-language reason, safe to show. */
  logo_error?: string;
}

export interface RenderRecord {
  render_id: string;
  aspect_ratio: AspectRatio;
  /** Set when a file was stored; links to it are signed on demand and never saved. */
  stored?: boolean;
  /** Set by renderers that host their own output (the stub). */
  url?: string;
  bytes?: number;
  duration_s?: number;
  notes?: string[];
  renderer_version?: string;
}

export interface VariantGroup {
  id: string;
  account_id: string;
  brand_kit_id?: string;
  tested_variable: string;
  base_ad_id: string;
  ad_ids: string[]; // base first, then variants in creation order
}

export interface Reservation {
  id: string;
  account_id: string;
  ad_id: string;
  amount: number;
  status: "held" | "settled" | "released";
}

export interface LedgerEntry {
  id: string;
  account_id: string;
  ad_id?: string;
  delta: number;
  reason: string;
}

export interface OutboxRow {
  id: string;
  account_id: string;
  topic: "script" | "generate" | "semantic" | "logo";
  payload: Record<string, unknown>;
  created_at: string;
  /** Set when a handler finished. A row that is claimed but never finished is delivered again after its lease runs out. */
  done_at?: string;
  claimed_until?: number;
}

export interface IdemRecord {
  hash: string;
  ad_id: string;
  group_id?: string;
  result_ad_ids?: string[];
  /** For requests whose answer is not an ad: the answer itself, so a repeat returns it unchanged. */
  result?: unknown;
}

export type LaunchMode = "platform_experiment" | "same_ad_set" | "separate";

/** Ties one finished ad to one live ad on an ad platform. */
export interface AdLink {
  id: string;
  account_id: string;
  ad_id: string;
  aspect_ratio?: string;
  platform: string;
  platform_ad_id: string;
  launch_mode: LaunchMode;
  created_at: string;
}

/** One day of results for one linked ad. Rows are never changed: a correction is a newer row for the same day. */
export interface SnapshotRow {
  id: string;
  account_id: string;
  link_id: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currency: string;
  timezone: string;
  attribution_window: string;
  metric_definition_version: string;
  source: "manual" | "import";
  created_at: string;
}
export interface SemanticRecord {
  status: "done" | "unavailable";
  findings: Finding[];
  discarded: number;
  error?: string;
}
export interface RenderFileRecord {
  account_id: string;
  ad_id: string;
  path: string;
  bytes: number;
}

export interface AuditEntry {
  id: string;
  account_id: string;
  actor: string;
  action: string;
  detail: unknown;
  at: string;
  prev_hash: string;
  hash: string;
}


export function hashEntry(prev: string, acct: string, actor: string, action: string, detail: unknown, at: string) {
  return createHash("sha256").update(JSON.stringify([prev, acct, actor, action, detail, at])).digest("hex");
}

/**
 * Everything the service does to state happens inside one transaction for one account. In Postgres that is a real
 * transaction with the account set for row-level security; in memory it is serialised and applied all at once on
 * success, so a failed operation leaves nothing behind. Reads return copies: change one, then save it.
 */
export interface Tx {
  readonly accountId: string;
  /** Number of outbox rows this transaction added. The service wakes the relay after commit when it is above zero. */
  enqueued: number;

  getAd(id: string): Promise<Ad | undefined>;
  /** Same as getAd, but other writers of this ad wait until this transaction ends. */
  lockAd(id: string): Promise<Ad | undefined>;
  insertAd(ad: Ad): Promise<void>;
  /** Writes the ad if nobody changed it since it was read; otherwise throws a conflict. */
  saveAd(ad: Ad): Promise<void>;
  listAds(limit: number): Promise<Ad[]>;
  countAds(statuses: Ad["status"][]): Promise<number>;
  adsOfBrandKit(kitId: string, status: Ad["status"]): Promise<Ad[]>;

  getKit(id: string): Promise<StoredKit | undefined>;
  putKit(kit: StoredKit): Promise<void>;
  countKits(): Promise<number>;
  countPendingLogos(): Promise<number>;
  getRules(kitId: string): Promise<RuleSet | undefined>;
  putRules(kitId: string, set: RuleSet): Promise<void>;

  /** Serialises everything that touches this account's idempotency key until the transaction ends. */
  lockKey(key: string): Promise<void>;
  getIdem(key: string): Promise<IdemRecord | undefined>;
  putIdem(key: string, rec: IdemRecord): Promise<void>;

  getGroup(id: string): Promise<VariantGroup | undefined>;
  putGroup(g: VariantGroup): Promise<void>;
  countGroups(): Promise<number>;

  putLink(link: AdLink): Promise<void>;
  getLink(id: string): Promise<AdLink | undefined>;
  linkByPlatformAd(platform: string, platformAdId: string): Promise<AdLink | undefined>;
  linksForAds(adIds: string[]): Promise<AdLink[]>;
  /** Adds rows. Never changes or removes one. */
  appendSnapshots(rows: SnapshotRow[]): Promise<void>;
  /** Every revision of every row for these links, oldest first. The caller keeps the newest per day. */
  snapshotsForLinks(linkIds: string[]): Promise<SnapshotRow[]>;
  listGroups(brandKitId?: string): Promise<VariantGroup[]>;

  getRender(id: string): Promise<RenderFileRecord | undefined>;
  putRender(id: string, rec: RenderFileRecord): Promise<void>;
  countRenders(): Promise<number>;
  /** Total size of this account's finished videos, in bytes. */
  renderBytes(): Promise<number>;

  getSemantic(key: string): Promise<SemanticRecord | undefined>;
  putSemantic(key: string, rec: SemanticRecord): Promise<void>;

  /** Takes this account's money lock. Call before reading a balance you are about to spend. */
  lockAccount(): Promise<void>;
  balance(): Promise<number>;
  held(): Promise<number>;
  addLedger(e: Omit<LedgerEntry, "account_id">): Promise<void>;
  ledger(): Promise<LedgerEntry[]>;
  putReservation(r: Omit<Reservation, "account_id">): Promise<void>;
  getReservation(id: string): Promise<Reservation | undefined>;
  reservationsForAd(adId: string): Promise<Reservation[]>;
  reservations(): Promise<Reservation[]>;

  /**
   * Shared, per-account rate limiting. Checks that `weight` more uses of `key` fit in the window and records them, or
   * throws the refusal. The use is recorded in its own short transaction that commits at once, so it counts even if the
   * request that made it fails or rolls back later (errors cannot be used to hammer the server), and every instance
   * sees the same counts. A refusal records nothing.
   */
  takeRate(key: string, opts: { limit: number; windowMs: number; weight: number; label: string; now: number }): Promise<void>;
  /** The uses of `key` still inside the window, oldest first. */
  rateEvents(key: string, windowMs: number, now: number): Promise<{ t: number; w: number }[]>;
  /** Records a use without checking. For amounts only known afterwards (bytes downloaded). */
  recordRate(key: string, weight: number, now: number): Promise<void>;

  enqueue(topic: OutboxRow["topic"], payload: Record<string, unknown>): Promise<void>;
  appendAudit(actor: string, action: string, detail: unknown): Promise<void>;
  audit(): Promise<AuditEntry[]>;
  verifyAudit(): Promise<boolean>;
}

export interface Store {
  /** "memory" loses everything on restart; "postgres" does not. Readiness reports it. */
  readonly kind: "memory" | "postgres";
  /** Records of provider calls, so a retry (even after a restart) never pays twice. */
  readonly providerCalls: ProviderCalls;
  tx<T>(accountId: string, fn: (t: Tx) => Promise<T>): Promise<T>;
  /** Claims unfinished outbox rows for this worker, across accounts. */
  claimOutbox(limit: number, leaseMs: number): Promise<OutboxRow[]>;
  completeOutbox(id: string): Promise<void>;
  /** Test and recovery hook: makes a finished row deliverable again. */
  redeliver(id: string): Promise<void>;
  outboxRows(): Promise<OutboxRow[]>;
  /** Unfinished outbox rows by topic, across accounts. Counts only; for monitoring. */
  queueDepth(): Promise<Record<string, number>>;
  /** Used by readiness. Rejects when the database cannot be reached. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
