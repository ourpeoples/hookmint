import { createHash, randomUUID } from "node:crypto";
import type { AspectRatio, BrandKit, JobStatus, ScenePlan } from "./schemas.js";
import { ProviderCalls } from "./provider-calls.js";
import type { Finding } from "../brand/check.js";
import type { RuleSet } from "../brand/rules.js";

export interface Ad {
  id: string;
  account_id: string;
  brand_kit_id?: string;
  prompt: string;
  duration_s: number;
  aspect_ratios: AspectRatio[];
  status: JobStatus;
  version: number; // bumped on every transition; guards concurrent writers
  plans: ScenePlan[]; // immutable versions; last is current
  assets: Record<string, { visual_url: string; voice_url: string }>;
  renders: { aspect_ratio: AspectRatio; url: string }[];
  regenerations: number;
  variant_of?: string; // base ad id, for ads created by create_variants
  error?: string;
  created_at: string;
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
  topic: "script" | "generate" | "semantic";
  payload: Record<string, unknown>;
  created_at: string;
  sent_at?: string;
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

/**
 * In-memory stand-in for Postgres. The service only reaches state through this class, so a Postgres
 * implementation (with row-level security) can replace it without touching the job logic.
 */
export class MemoryStore {
  ads = new Map<string, Ad>();
  brandKits = new Map<string, BrandKit & { account_id: string }>();
  brandRules = new Map<string, RuleSet>(); // keyed by brand kit id
  idempotency = new Map<string, { hash: string; ad_id: string; group_id?: string; result_ad_ids?: string[] }>();
  variantGroups = new Map<string, VariantGroup>();
  /** Cached model-based brand findings, keyed by ad, plan version and rule-set version. */
  semantic = new Map<string, { status: "done" | "unavailable"; findings: Finding[]; discarded: number; error?: string }>();
  semanticPending = new Set<string>();
  ledger: LedgerEntry[] = [];
  reservations = new Map<string, Reservation>();
  outbox: OutboxRow[] = [];
  audit: AuditEntry[] = [];
  providerCalls: ProviderCalls;

  constructor(retryBaseMs?: number) {
    this.providerCalls = new ProviderCalls(retryBaseMs);
  }

  balance(accountId: string) {
    return this.ledger.filter((e) => e.account_id === accountId).reduce((n, e) => n + e.delta, 0);
  }
  held(accountId: string) {
    return [...this.reservations.values()]
      .filter((r) => r.account_id === accountId && r.status === "held")
      .reduce((n, r) => n + r.amount, 0);
  }
  available(accountId: string) {
    return this.balance(accountId) - this.held(accountId);
  }

  appendAudit(accountId: string, actor: string, action: string, detail: unknown) {
    const prev = [...this.audit].reverse().find((e) => e.account_id === accountId)?.hash ?? "genesis";
    const at = new Date().toISOString();
    const hash = hashEntry(prev, accountId, actor, action, detail, at);
    this.audit.push({ id: randomUUID(), account_id: accountId, actor, action, detail, at, prev_hash: prev, hash });
  }

  verifyAudit(accountId: string): boolean {
    let prev = "genesis";
    for (const e of this.audit.filter((x) => x.account_id === accountId)) {
      if (e.prev_hash !== prev || e.hash !== hashEntry(prev, accountId, e.actor, e.action, e.detail, e.at)) return false;
      prev = e.hash;
    }
    return true;
  }
}

function hashEntry(prev: string, acct: string, actor: string, action: string, detail: unknown, at: string) {
  return createHash("sha256").update(JSON.stringify([prev, acct, actor, action, detail, at])).digest("hex");
}
