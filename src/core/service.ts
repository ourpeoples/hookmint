import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { DownloadSigner, type SignedLink } from "./downloads.js";
import { DEFAULT_LIMITS, HOUR, type Limits, MINUTE, RateLimiter } from "./limits.js";
import { AdError } from "./errors.js";
import { buildRules, type ExampleInput, type RuleInput, type RuleSet } from "../brand/rules.js";
import { checkPlan, type Finding, sortFindings, summarize } from "../brand/check.js";
import { validateSemantic } from "../brand/semantic.js";
import { checkVariant, DEFAULT_MIN_DISTANCE, fingerprint, textDistance, type DiffEntry, type TestedVariable } from "../variants/diff.js";
import { type Ctx, requireScope } from "./context.js";
import {
  type AspectRatio,
  type BrandKit,
  type JobStatus,
  type Scene,
  type ScenePlan,
  ScenePlan as ScenePlanSchema,
  TERMINAL,
  totalDuration,
  upgradePlan,
} from "./schemas.js";
import { type Estimate, estimateApproval, estimateRegeneration, RENDER_CREDITS_PER_ASPECT, visualCredits, VOICE_CREDITS } from "./costs.js";
import { analyzeGroup, insightsFrom, type GroupReport, type Insight, type LaunchMode, type Snapshot } from "../insights/analyze.js";
import { testedValue } from "../insights/describe.js";
import { isRealDate, LinkInput, PerformanceInput, TestPlanInput } from "../insights/schemas.js";
import { METHOD_VERSION, sampleSizePerVariant } from "../insights/stats.js";
import { MemoryStore } from "./memory-store.js";
import { StoreFetchQuota } from "./shared-quota.js";
import { type Ad, type OutboxRow, type Reservation, type SemanticRecord, type Store, type StoredKit, type Tx, type VariantGroup } from "./store.js";
import type { MediaIngestor } from "../net/ingest.js";
import type { Learning, Providers } from "../providers/types.js";

export type { Ad } from "./store.js";

export interface SceneEdit {
  scene_id: string;
  voiceover?: string;
  on_screen_text?: string;
  visual_prompt?: string;
  duration_s?: number;
}
export interface ScriptEdits {
  hook?: string;
  cta_text?: string;
  scenes?: SceneEdit[];
}
export interface ServiceOptions {
  regenBudget: number;
  retryBaseMs: number;
  /** Most variants a single base ad can have across all create_variants calls. */
  maxVariantsPerBase: number;
  /** Minimum word distance between a variant and the base, and between any two variants. */
  minVariantDistance: number;
  /** Where finished videos are written. Without it, renderers that produce files cannot be used. */
  renderDir?: string;
  /** Signs the short-lived download links. Defaults to a random per-process secret. */
  downloads: DownloadSigner;
  /** Show local file paths in results. Only sensible when the caller is on the same machine (stdio). */
  exposeLocalPaths: boolean;
  /** Downloads logos and remote scene media into the renderer's asset folder. Without it, remote media is not used. */
  ingestor?: MediaIngestor;
  limits: Limits;
  /** Clock for the rate limits. Tests replace it. */
  now: () => number;
}

export interface VariantResult {
  variant_group_id: string;
  tested_variable: TestedVariable;
  base_ad_id: string;
  variants: { ad: Ad; diff: DiffEntry[]; check: ReturnType<typeof summarize> }[];
}

export type SemanticStatus = "none" | "off" | "pending" | "done" | "unavailable";
const semanticKey = (adId: string, planVersion: number, ruleVersion: number) => `${adId}:p${planVersion}:r${ruleVersion}`;

/** Embedded in the video file: states that it is AI-generated and which ad, plan and template produced it. */
function provenance(ad: Ad, plan: ScenePlan, planVersion: number): Record<string, string> {
  return {
    title: "Hookmint ad",
    // "description" survives into the MP4 untouched; "comment" would get a Remotion prefix.
    description: JSON.stringify({
      ai_generated: true,
      generator: "hookmint",
      ad_id: ad.id,
      plan_version: planVersion,
      hook_id: plan.hook_id,
      variant_group_id: plan.variant_group_id,
      template: plan.template,
      ai_voice: Object.values(ad.assets).some((a) => a.ai_voice) || undefined,
      rendered_at: new Date().toISOString(),
    }),
  };
}

const guidanceFor = (set?: RuleSet, learnings: Learning[] = []) =>
  set || learnings.length ? { rules: set ? set.rules.map((r) => ({ type: r.type, pattern: r.pattern })) : [], examples: set ? set.examples : [], learnings } : undefined;

/** Short unique id with a readable prefix, e.g. h_3fa9c01b22de (hex only, no separators). */
const mintId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Thrown inside a handler when another writer moved the job on (cancel, redelivery). Not an error. */
class Superseded extends Error {}

const LEASE_MS = 60_000;

/**
 * The single service layer. MCP tools and REST routes both call this; neither contains business logic.
 * Every state change is one transaction for one account (a real database transaction with row-level security
 * when the store is Postgres). Work is handed to workers through a transactional outbox, spend goes through
 * reservations, and each provider call runs at most once per key. Slow provider calls happen between
 * transactions, never inside one, and a result is applied only if the ad is still at the version that asked for it.
 */
export class AdService {
  readonly store: Store;
  /** Providers whose circuit breaker is open, for the readiness report. */
  openBreakers(): string[] {
    return this.store.providerCalls.openBreakers();
  }
  get storeKind(): "memory" | "postgres" {
    return this.store.kind;
  }
  private opts: ServiceOptions;
  readonly downloads: DownloadSigner;
  private limiter: RateLimiter;
  private variantsInFlight = new Map<string, { hash: string; promise: Promise<VariantResult> }>();
  private semanticPending = new Set<string>();
  private inflight = new Set<Promise<unknown>>();
  private relaying = false;
  private again = false;
  private poller?: NodeJS.Timeout;
  private stopped = false;

  constructor(private providers: Providers, opts: Partial<ServiceOptions> = {}, store?: Store) {
    this.opts = { regenBudget: 3, retryBaseMs: 200, maxVariantsPerBase: 10, minVariantDistance: DEFAULT_MIN_DISTANCE, downloads: new DownloadSigner(), exposeLocalPaths: false, limits: DEFAULT_LIMITS, now: Date.now, ...opts };
    this.downloads = this.opts.downloads;
    this.limiter = new RateLimiter(this.opts.now);
    this.store = store ?? new MemoryStore(this.opts.retryBaseMs);
    // Downloads are limited per account per day. Unless the ingestor was given its own allowance (tests), use one kept in
    // the store, so every instance counts the same downloads.
    if (this.opts.ingestor && !this.opts.ingestor.hasQuota()) this.opts.ingestor.useQuota(new StoreFetchQuota(this.store, this.opts.limits, this.opts.now));
  }

  // ---------- running work ----------

  /** One transaction for one account. When it queued work, the relay is woken after it commits. */
  private async run<T>(accountId: string, fn: (t: Tx) => Promise<T>): Promise<T> {
    let queued = false;
    const out = await this.store.tx(accountId, async (t) => {
      const r = await fn(t);
      queued = t.enqueued > 0;
      return r;
    });
    if (queued) this.kick();
    return out;
  }

  /** Starts a timer that picks up work other instances left behind, or that was never finished before a restart. */
  start(intervalMs = 2000) {
    this.stopped = false;
    this.poller ??= setInterval(() => this.kick(), intervalMs);
    this.poller.unref?.();
    this.kick();
  }

  /** Stops taking new work and waits (up to `timeoutMs`) for the work in progress. */
  async drain(timeoutMs = 25_000): Promise<boolean> {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 50))]);
    return this.inflight.size === 0;
  }

  // ---------- limits ----------

  get limits(): Limits {
    return this.opts.limits;
  }

  /** Counts one request against the account's per-minute allowance. Both transports call this. */
  admit(ctx: Ctx): void {
    this.limiter.take(ctx.accountId, "requests", this.opts.limits.requestsPerMinute, MINUTE, { label: "requests" });
  }

  /** Counts a use against one of the account's hourly allowances, shared by every instance. Refusing rolls the transaction back, so a refused request leaves no trace. */
  private async takeIn(t: Tx, ctx: Ctx, key: string, limit: number, windowMs: number, label: string, weight = 1) {
    await t.takeRate(key, { limit, windowMs, weight, label, now: this.opts.now() });
  }

  /** Videos being generated or rendered right now. One account cannot fill the queue for everyone. */
  private async assertRoomForJob(t: Tx) {
    const active = await t.countAds(["generating", "rendering"]);
    if (active >= this.opts.limits.maxActiveJobs) {
      throw new AdError("rate_limited", `${active} of your videos are being made right now, which is the most allowed at once. Try again when one finishes.`, 30, { retry: false });
    }
  }

  // ---------- accounts and credits ----------

  /** Invite-only v1: credits are granted manually by an operator. */
  async grantCredits(accountId: string, amount: number, reason: string) {
    await this.run(accountId, async (t) => {
      await t.lockAccount();
      await t.addLedger({ id: randomUUID(), delta: amount, reason });
      await t.appendAudit("operator", "credits.grant", { amount, reason });
    });
  }

  /** Gives an account its starting credits, once. A restart or a second instance never adds them again. Returns whether it granted. */
  async grantStarterCredits(accountId: string, amount: number, reason: string): Promise<boolean> {
    return this.run(accountId, async (t) => {
      await t.lockAccount();
      if ((await t.ledger()).length > 0) return false;
      await t.addLedger({ id: randomUUID(), delta: amount, reason });
      await t.appendAudit("operator", "credits.grant", { amount, reason });
      return true;
    });
  }

  async getBalance(ctx: Ctx) {
    return this.run(ctx.accountId, (t) => this.balanceOf(t));
  }
  private async balanceOf(t: Tx) {
    const [balance, held] = await Promise.all([t.balance(), t.held()]);
    return { available: balance - held, held };
  }

  // ---------- brand kits ----------

  /**
   * A logo address is checked straight away (https, public, no credentials) and then downloaded in the background,
   * so the call returns at once and `logo_status` moves from "pending" to "ready" or "failed".
   */
  async createBrandKit(ctx: Ctx, input: Omit<BrandKit, "id">): Promise<BrandKit & { logo_status: StoredKit["logo_status"] }> {
    requireScope(ctx, "brand:write");
    return this.run(ctx.accountId, async (t) => {
      await this.takeIn(t, ctx, "create_brand_kit", this.opts.limits.createBrandKitPerHour, HOUR, "brand kits");
      if (input.logo_url && this.opts.ingestor) {
        const pending = await t.countPendingLogos();
        if (pending >= this.opts.limits.maxPendingLogos) throw new AdError("rate_limited", `${pending} of your logos are still downloading, which is the most allowed at once. Try again in a moment.`, 30, { retry: false });
      }
      const kit: StoredKit = { ...input, id: `bk_${randomUUID().slice(0, 8)}`, account_id: ctx.accountId, logo_status: "none" };
      if (input.logo_url) {
        if (!this.opts.ingestor) {
          kit.logo_status = "unavailable";
          kit.logo_error = "Logo downloading is not set up on this server, so the logo will not appear in videos.";
        } else {
          this.opts.ingestor.checkUrl(input.logo_url); // refuses a bad address before anything is stored or queued
          kit.logo_status = "pending";
        }
      }
      await t.putKit(kit);
      if (kit.logo_status === "pending") await t.enqueue("logo", { kit_id: kit.id });
      return this.publicKit(kit);
    });
  }

  async getBrandKit(ctx: Ctx, id: string) {
    requireScope(ctx, "brand:read");
    return this.run(ctx.accountId, async (t) => {
      const kit = await t.getKit(id);
      if (!kit) throw new AdError("not_found", `Unknown brand_kit_id ${id}.`);
      return { ...this.publicKit(kit), rule_set_version: (await t.getRules(id))?.version ?? null };
    });
  }

  private publicKit(kit: StoredKit) {
    const { account_id: _a, logo_path: _p, logo_error, ...rest } = kit;
    return { ...rest, ...(logo_error ? { logo_error } : {}) };
  }

  private async runLogo(accountId: string, p: { kit_id: string }) {
    const ingestor = this.opts.ingestor;
    const kit = await this.run(accountId, (t) => t.getKit(p.kit_id));
    if (!kit || kit.logo_status !== "pending" || !kit.logo_url || !ingestor) return; // stale or repeated delivery
    const url = kit.logo_url;
    let result: Partial<StoredKit>;
    try {
      const got = await this.store.providerCalls.runOnce(`${kit.account_id}:${kit.id}:logo:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`, { provider: "logo", cost_credits: 0 }, async () => ({ path: (await ingestor.logo(kit.account_id, kit.id, url)).path }));
      result = { logo_status: "ready", logo_path: got.path };
    } catch (err) {
      result = { logo_status: "failed", logo_error: err instanceof AdError ? err.message : "The logo could not be downloaded." };
    }
    await this.run(accountId, async (t) => {
      const fresh = await t.getKit(kit.id);
      if (!fresh || fresh.logo_status !== "pending") return;
      const next = { ...fresh, ...result };
      if (result.logo_status === "ready") delete next.logo_error;
      await t.putKit(next);
    });
  }

  /** Replaces the whole rule set for a brand kit. Each save is a new version; findings record the version they used. */
  async setBrandRules(ctx: Ctx, kitId: string, input: { rules: RuleInput[]; examples?: ExampleInput[] }) {
    requireScope(ctx, "brand:write");
    return this.run(ctx.accountId, async (t) => {
      await this.takeIn(t, ctx, "set_brand_rules", this.opts.limits.setBrandRulesPerHour, HOUR, "rule changes");
      const kit = await t.getKit(kitId);
      if (!kit) throw new AdError("not_found", `Unknown brand_kit_id ${kitId}.`);
      const rules = buildRules(input.rules);
      await t.lockKey(`rules:${kitId}`);
      const version = ((await t.getRules(kitId))?.version ?? 0) + 1;
      await t.putRules(kitId, { account_id: ctx.accountId, version, rules, examples: input.examples ?? [] });
      await t.appendAudit("user", "brand.rules.set", { brand_kit_id: kitId, version, rule_count: rules.length });
      for (const ad of await t.adsOfBrandKit(kitId, "awaiting_approval")) await this.ensureSemantic(t, ad);
      return { brand_kit_id: kitId, version, rule_count: rules.length, example_count: (input.examples ?? []).length };
    });
  }

  /**
   * Findings for the ad's current plan against the brand kit's current rules: deterministic ones computed now, plus
   * cached model-based ones for this exact plan and rule version. Model findings are advisory and never block.
   */
  private async findingsIn(t: Tx, ad: Ad): Promise<{ findings: Finding[]; rule_set_version: number | null; semantic: { status: SemanticStatus; discarded: number } }> {
    const plan = ad.plans.at(-1);
    const set = ad.brand_kit_id ? await t.getRules(ad.brand_kit_id) : undefined;
    if (!plan || !set) return { findings: [], rule_set_version: set?.version ?? null, semantic: { status: "none", discarded: 0 } };
    const findings = checkPlan(plan, set.rules, set.version);
    let semantic: { status: SemanticStatus; discarded: number } = { status: "none", discarded: 0 };
    if (set.rules.some((r) => r.type === "semantic")) {
      const hit = await t.getSemantic(semanticKey(ad.id, ad.plans.length, set.version));
      if (!this.providers.semantic) semantic = { status: "off", discarded: 0 };
      else if (!hit) semantic = { status: "pending", discarded: 0 };
      else {
        semantic = { status: hit.status, discarded: hit.discarded };
        findings.push(...hit.findings);
      }
    }
    return { findings: sortFindings(findings), rule_set_version: set.version, semantic };
  }

  /** Queue a model-based check for this plan and rule version, once. Never blocks and never fails the ad. */
  private async ensureSemantic(t: Tx, ad: Ad) {
    if (!this.providers.semantic || !ad.plans.length) return;
    const set = ad.brand_kit_id ? await t.getRules(ad.brand_kit_id) : undefined;
    if (!set || !set.rules.some((r) => r.type === "semantic")) return;
    const key = semanticKey(ad.id, ad.plans.length, set.version);
    if ((await t.getSemantic(key)) || this.semanticPending.has(key)) return;
    this.semanticPending.add(key);
    await t.enqueue("semantic", { ad_id: ad.id, plan_version: ad.plans.length, rule_version: set.version });
  }

  private async runSemantic(accountId: string, p: { ad_id: string; plan_version: number; rule_version: number }) {
    const key = semanticKey(p.ad_id, p.plan_version, p.rule_version);
    try {
      if (!this.providers.semantic) return;
      const seen = await this.run(accountId, async (t) => {
        if (await t.getSemantic(key)) return undefined;
        const ad = await t.getAd(p.ad_id);
        const set = ad?.brand_kit_id ? await t.getRules(ad.brand_kit_id) : undefined;
        const plan = ad?.plans[p.plan_version - 1];
        if (!ad || !set || set.version !== p.rule_version || !plan) return undefined; // stale: rules or plan moved on
        return { plan, set };
      });
      if (!seen) return;
      const { plan, set } = seen;
      let record: SemanticRecord;
      try {
        const raw = await this.store.providerCalls.runOnce(`${accountId}:${key}:semantic`, { provider: "semantic", cost_credits: 0 }, () =>
          this.providers.semantic!.check({ plan, rules: set.rules }),
        );
        const { findings, discarded } = validateSemantic(raw, plan, set.rules, set.version);
        record = { status: "done", findings, discarded };
      } catch (err) {
        record = { status: "unavailable", findings: [], discarded: 0, error: err instanceof Error ? err.message : String(err) };
      }
      await this.run(accountId, (t) => t.putSemantic(key, record));
    } finally {
      this.semanticPending.delete(key);
    }
  }

  async checkAd(ctx: Ctx, id: string) {
    requireScope(ctx, "ads:read");
    return this.run(ctx.accountId, async (t) => {
      const ad = await this.requireAd(t, id);
      if (!ad.plans.length) throw new AdError("conflict", "The script is not ready yet. Poll get_ad_status.");
      await this.ensureSemantic(t, ad);
      const { findings, rule_set_version, semantic } = await this.findingsIn(t, ad);
      return { plan_version: ad.plans.length, rule_set_version, semantic_status: semantic.status, semantic_discarded: semantic.discarded, ...summarize(findings), findings };
    });
  }

  /** Everything a client sees alongside an ad: its check, the balance and the download links. One consistent read. */
  async describe(ctx: Ctx, ad: Ad) {
    return this.run(ctx.accountId, async (t) => {
      const { findings, rule_set_version, semantic } = await this.findingsIn(t, ad);
      return { check: { rule_set_version, semantic_status: semantic.status, ...summarize(findings), findings }, balance: await this.balanceOf(t), renders: await this.renderViews(t, ad) };
    });
  }

  // ---------- ads ----------

  async createAd(
    ctx: Ctx,
    input: { prompt: string; brand_kit_id?: string; duration_s: number; aspect_ratios: AspectRatio[]; idempotency_key: string },
  ): Promise<Ad> {
    requireScope(ctx, "ads:create");
    const { idempotency_key, ...args } = input;
    return this.run(ctx.accountId, (t) =>
      this.idem(t, ctx, "create_ad", idempotency_key, args, async () => {
        await this.takeIn(t, ctx, "create_ad", this.opts.limits.createAdPerHour, HOUR, "new ads");
        if (args.brand_kit_id && !(await t.getKit(args.brand_kit_id))) {
          throw new AdError("not_found", `Unknown brand_kit_id ${args.brand_kit_id}. Call create_brand_kit first.`);
        }
        const ad: Ad = {
          id: `ad_${randomUUID().slice(0, 8)}`,
          account_id: ctx.accountId,
          brand_kit_id: args.brand_kit_id,
          prompt: args.prompt,
          duration_s: args.duration_s,
          aspect_ratios: args.aspect_ratios,
          status: "scripting",
          version: 1,
          plans: [],
          assets: {},
          renders: [],
          regenerations: 0,
          created_at: new Date().toISOString(),
        };
        await t.insertAd(ad);
        await t.enqueue("script", { ad_id: ad.id, version: ad.version });
        return ad;
      }),
    );
  }

  /**
   * Creates `count` variants of an ad that differ on exactly one tested variable. The provider proposes plans;
   * the diff engine decides whether each one is a valid variant. All or none are created.
   */
  async createVariants(
    ctx: Ctx,
    id: string,
    input: { count: number; tested_variable: TestedVariable; idempotency_key: string },
  ): Promise<VariantResult> {
    requireScope(ctx, "ads:create");
    const { idempotency_key, ...args } = input;
    const k = `${ctx.accountId}:${idempotency_key}`;
    const hash = createHash("sha256").update(JSON.stringify(["create_variants", { id, ...args }])).digest("hex");

    const prior = await this.run(ctx.accountId, async (t) => {
      const p = await t.getIdem(k);
      if (!p) return undefined;
      if (p.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
      return this.variantResult(t, p.group_id!, p.ad_id, p.result_ad_ids!);
    });
    if (prior) return prior;
    const running = this.variantsInFlight.get(k);
    if (running) {
      if (running.hash !== hash) throw new AdError("conflict", "This idempotency_key is already in use for a different request.");
      return running.promise;
    }
    const promise = this.doCreateVariants(ctx, id, input, k, hash).finally(() => this.variantsInFlight.delete(k));
    this.variantsInFlight.set(k, { hash, promise });
    return promise;
  }

  private async doCreateVariants(
    ctx: Ctx,
    id: string,
    input: { count: number; tested_variable: TestedVariable; idempotency_key: string },
    idemKey: string,
    hash: string,
  ): Promise<VariantResult> {
    const start = await this.run(ctx.accountId, async (t) => {
      const base = await this.requireAd(t, id);
      if (base.status !== "awaiting_approval" && base.status !== "completed") {
        throw new AdError("conflict", `create_variants needs a ready or finished ad, but ${id} is "${base.status}".`);
      }
      const basePlan = this.currentPlan(base);
      const groupId = basePlan.variant_group_id;
      await this.takeIn(t, ctx, "create_variants", this.opts.limits.createVariantsPerHour, HOUR, "variants", input.count); // a replay never reaches here
      const known = await t.getGroup(groupId);
      if (known && known.tested_variable !== input.tested_variable) {
        throw new AdError("conflict", `This ad's variant group already tests "${known.tested_variable}". One group tests one variable, so create variants of a different ad to test "${input.tested_variable}".`);
      }
      const brand = base.brand_kit_id ? await t.getKit(base.brand_kit_id) : undefined;
      const existing: ScenePlan[] = [];
      for (const x of known?.ad_ids ?? [base.id]) existing.push((await t.getAd(x))!.plans.at(-1)!);
      return { base, basePlan, groupId, brand, existing, learnings: await this.learningsFor(t, base.brand_kit_id) };
    });
    const { base, basePlan, groupId, brand, existing, learnings } = start;

    // Keyed on the idempotency key: a retry of this request reuses the result, a new request never does.
    const callKey = `${idemKey}:variants:${base.id}`;
    const raw = await this.store.providerCalls.runOnce(callKey, { provider: "variants", cost_credits: 0 }, () =>
      this.providers.variants.generate({ basePlan, tested_variable: input.tested_variable, count: input.count, brand, existing, learnings }),
    );

    // The group is locked for the rest of this transaction, so it cannot change between these checks and the writes.
    return this.run(ctx.accountId, async (t) => {
      await t.lockKey(`group:${groupId}`);
      await t.lockKey(`idem:${idemKey}`);
      const again = await t.getIdem(idemKey);
      if (again) {
        if (again.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
        return this.variantResult(t, again.group_id!, again.ad_id, again.result_ad_ids!);
      }
      const group: VariantGroup = (await t.getGroup(groupId)) ?? { id: groupId, account_id: ctx.accountId, brand_kit_id: base.brand_kit_id, tested_variable: input.tested_variable, base_ad_id: base.id, ad_ids: [base.id] };
      if (group.tested_variable !== input.tested_variable) throw new AdError("conflict", `This ad's variant group already tests "${group.tested_variable}".`);
      if (group.ad_ids.length - 1 + input.count > this.opts.maxVariantsPerBase) {
        throw new AdError("rate_limited", `An ad can have at most ${this.opts.maxVariantsPerBase} variants; this one has ${group.ad_ids.length - 1}.`, undefined, { retry: false });
      }
      if (raw.length !== input.count) throw new AdError("invalid_input", `The variant provider returned ${raw.length} plan(s) for ${input.count} requested.`);

      const seen: { label: string; fp: string }[] = [];
      for (const x of group.ad_ids) seen.push({ label: x === base.id ? "the base" : `variant ${x}`, fp: fingerprint((await t.getAd(x))!.plans.at(-1)!, input.tested_variable, basePlan) });
      const accepted: { plan: ScenePlan; diff: DiffEntry[] }[] = [];
      raw.forEach((item, i) => {
        const label = `Variant ${i + 1}`;
        const parsed = ScenePlanSchema.safeParse(upgradePlan(item));
        if (!parsed.success) throw new AdError("invalid_input", `${label} is not a valid plan: ${parsed.error.message}`);
        // Server-owned fields come from the base, not the provider.
        const plan: ScenePlan = {
          ...parsed.data,
          schema_version: basePlan.schema_version,
          template: basePlan.template,
          variant_group_id: groupId,
          hook_id: input.tested_variable === "hook" ? mintId("h") : basePlan.hook_id,
          variant: undefined,
        };
        const verdict = checkVariant(basePlan, plan, input.tested_variable, this.opts.minVariantDistance);
        if (!verdict.ok) throw new AdError("invalid_input", `${label} ${verdict.reason}.`);
        const fp = fingerprint(plan, input.tested_variable, basePlan);
        for (const other of seen) {
          const d = textDistance(fp, other.fp);
          if (d < this.opts.minVariantDistance) {
            throw new AdError("invalid_input", `${label} is too similar to ${other.label} (word distance ${d.toFixed(2)}, minimum ${this.opts.minVariantDistance}).`);
          }
        }
        seen.push({ label, fp });
        plan.variant = { tested_variable: input.tested_variable, base_ad_id: base.id, diff: verdict.diff };
        accepted.push({ plan, diff: verdict.diff });
      });

      const ids: string[] = [];
      for (const { plan } of accepted) {
        const ad: Ad = {
          id: `ad_${randomUUID().slice(0, 8)}`,
          account_id: ctx.accountId,
          brand_kit_id: base.brand_kit_id,
          prompt: base.prompt,
          duration_s: base.duration_s,
          aspect_ratios: base.aspect_ratios,
          status: "awaiting_approval",
          version: 1,
          plans: [plan],
          assets: {},
          renders: [],
          regenerations: 0,
          variant_of: base.id,
          created_at: new Date().toISOString(),
        };
        await t.insertAd(ad);
        group.ad_ids.push(ad.id);
        await this.ensureSemantic(t, ad);
        ids.push(ad.id);
      }
      await t.putGroup(group);
      await t.putIdem(idemKey, { hash, ad_id: base.id, group_id: groupId, result_ad_ids: ids });
      await t.appendAudit("user", "variants.create", { base_ad_id: base.id, variant_group_id: groupId, tested_variable: input.tested_variable, ad_ids: ids });
      return this.variantResult(t, groupId, base.id, ids);
    });
  }

  private async variantResult(t: Tx, groupId: string, baseId: string, adIds: string[]): Promise<VariantResult> {
    const group = (await t.getGroup(groupId))!;
    const variants: VariantResult["variants"] = [];
    for (const x of adIds) {
      const ad = await this.requireAd(t, x);
      variants.push({ ad, diff: ad.plans[0].variant!.diff, check: summarize((await this.findingsIn(t, ad)).findings) });
    }
    return { variant_group_id: groupId, tested_variable: group.tested_variable as TestedVariable, base_ad_id: baseId, variants };
  }

  async getAd(ctx: Ctx, id: string): Promise<Ad> {
    requireScope(ctx, "ads:read");
    return this.run(ctx.accountId, (t) => this.requireAd(t, id));
  }

  async listAds(ctx: Ctx, limit: number): Promise<Ad[]> {
    requireScope(ctx, "ads:read");
    return this.run(ctx.accountId, (t) => t.listAds(limit));
  }

  async estimateCost(ctx: Ctx, id: string): Promise<Estimate & { balance: { available: number; held: number } }> {
    requireScope(ctx, "ads:read");
    return this.run(ctx.accountId, async (t) => {
      const ad = await this.requireAd(t, id);
      const plan = this.currentPlan(ad);
      return { ...estimateApproval(plan, new Set(Object.keys(ad.assets))), balance: await this.balanceOf(t) };
    });
  }

  /** Free animatic: timing and captions per scene. No provider is called. */
  async getStoryboard(ctx: Ctx, id: string) {
    requireScope(ctx, "ads:read");
    const ad = await this.run(ctx.accountId, (t) => this.requireAd(t, id));
    const plan = this.currentPlan(ad);
    let t0 = 0;
    const frames = plan.scenes.map((s) => {
      const frame = { scene_id: s.id, start_s: t0, duration_s: s.duration_s, caption: s.on_screen_text ?? s.voiceover };
      t0 += s.duration_s;
      return frame;
    });
    return {
      plan_version: ad.plans.length,
      url: `https://example.invalid/storyboards/${ad.id}/v${ad.plans.length}`,
      total_s: t0,
      frames,
    };
  }

  async updateScript(ctx: Ctx, id: string, edits: ScriptEdits): Promise<Ad> {
    requireScope(ctx, "ads:create");
    return this.run(ctx.accountId, async (t) => {
      const ad = await this.requireStatus(t, id, "awaiting_approval", "update_script", true);
      const next = structuredClone(this.currentPlan(ad));
      const dropped: string[] = [];
      if (edits.hook !== undefined) next.hook = edits.hook;
      if (edits.cta_text !== undefined) next.cta.text = edits.cta_text;
      for (const e of edits.scenes ?? []) {
        const scene = next.scenes.find((s) => s.id === e.scene_id);
        if (!scene) throw new AdError("invalid_input", `Unknown scene_id ${e.scene_id}.`);
        if (e.voiceover !== undefined) scene.voiceover = e.voiceover;
        if (e.on_screen_text !== undefined) scene.on_screen_text = e.on_screen_text;
        if (e.visual_prompt !== undefined) scene.visual_prompt = e.visual_prompt;
        if (e.duration_s !== undefined) scene.duration_s = e.duration_s;
        dropped.push(scene.id);
      }
      const parsed = ScenePlanSchema.safeParse(next);
      if (!parsed.success) throw new AdError("invalid_input", `Edited plan is invalid: ${parsed.error.message}`);
      this.checkDuration(parsed.data, ad.duration_s);
      for (const sceneId of dropped) delete ad.assets[sceneId]; // edited scenes need fresh assets
      ad.plans.push(parsed.data);
      ad.version++;
      await t.saveAd(ad);
      await this.ensureSemantic(t, ad);
      return ad;
    });
  }

  /** Spends credits, so it needs the same gate as approval. Without `confirm` it only returns an estimate. */
  async regenerateScene(
    ctx: Ctx,
    id: string,
    input: { scene_id: string; instruction: string; confirm?: boolean; max_credits?: number; idempotency_key: string },
  ): Promise<{ ad: Ad; estimate: Estimate; started: boolean }> {
    requireScope(ctx, "ads:create", "spend");
    return this.run(ctx.accountId, async (t) => {
      const ad0 = await this.requireStatus(t, id, "awaiting_approval", "regenerate_scene");
      const scene = this.currentPlan(ad0).scenes.find((s) => s.id === input.scene_id);
      if (!scene) throw new AdError("invalid_input", `Unknown scene_id ${input.scene_id}.`);
      const estimate = estimateRegeneration(scene);
      if (!input.confirm) return { ad: ad0, estimate, started: false };
      if (input.max_credits === undefined) throw new AdError("invalid_input", "max_credits is required when confirm is true.");

      const { idempotency_key, confirm: _c, ...args } = input;
      let started = false;
      const result = await this.idem(t, ctx, "regenerate_scene", idempotency_key, { id, ...args }, async () => {
        await t.lockAccount();
        const ad = (await t.lockAd(id))!;
        if (ad.status !== "awaiting_approval") throw new AdError("conflict", `regenerate_scene needs status "awaiting_approval" but ad ${id} is "${ad.status}".`);
        if (ad.regenerations >= this.opts.regenBudget) {
          throw new AdError("rate_limited", `This ad used its ${this.opts.regenBudget} scene regenerations.`, undefined, { retry: false });
        }
        await this.assertRoomForJob(t);
        await this.takeIn(t, ctx, "spend", this.opts.limits.spendActionsPerHour, HOUR, "paid actions");
        const reservation = await this.reserve(t, ctx, ad, estimate, input.max_credits!);
        const plan = structuredClone(this.currentPlan(ad));
        const target = plan.scenes.find((s) => s.id === input.scene_id)!;
        target.visual_prompt = `${target.visual_prompt} | Revision: ${input.instruction}`;
        ad.plans.push(plan);
        delete ad.assets[input.scene_id];
        ad.regenerations++;
        this.transition(ad, ["awaiting_approval"], "generating");
        await t.saveAd(ad);
        await this.ensureSemantic(t, ad);
        await t.appendAudit("user", "scene.regenerate", { ad_id: ad.id, scene_id: input.scene_id, credits: estimate.credits });
        await t.enqueue("generate", { ad_id: ad.id, version: ad.version, reservation_id: reservation.id, kind: "regen", scene_id: input.scene_id });
        started = true;
        return ad;
      });
      return { ad: result, estimate, started };
    });
  }

  async approveAndRender(ctx: Ctx, id: string, input: { max_credits: number; idempotency_key: string; override_reason?: string }): Promise<Ad> {
    requireScope(ctx, "ads:approve", "spend");
    const { idempotency_key, ...args } = input;
    return this.run(ctx.accountId, (t) =>
      this.idem(t, ctx, "approve_and_render", idempotency_key, { id, ...args }, async () => {
        await t.lockAccount();
        const ad = await this.requireStatus(t, id, "awaiting_approval", "approve_and_render", true);
        const plan = this.currentPlan(ad);
        const blocking = (await this.findingsIn(t, ad)).findings.filter((f) => f.severity === "block");
        if (blocking.length && !input.override_reason) {
          const ids = [...new Set(blocking.map((f) => f.rule_id))].join(", ");
          throw new AdError("blocked_by_rule", `${blocking.length} blocking finding(s) from rule(s) ${ids}. Fix the script (see check_ad) or pass override_reason.`);
        }
        await this.assertRoomForJob(t);
        await this.takeIn(t, ctx, "spend", this.opts.limits.spendActionsPerHour, HOUR, "paid actions");
        const estimate = estimateApproval(plan, new Set(Object.keys(ad.assets)));
        const reservation = await this.reserve(t, ctx, ad, estimate, input.max_credits);
        this.transition(ad, ["awaiting_approval"], "generating");
        await t.saveAd(ad);
        if (blocking.length) {
          await t.appendAudit("user", "ad.override", {
            ad_id: ad.id,
            plan_version: ad.plans.length,
            reason: input.override_reason,
            findings: blocking.map((f) => ({ rule_id: f.rule_id, rule_version: f.rule_version, scene_id: f.scene_id, field: f.field, evidence_quote: f.evidence_quote })),
          });
        }
        await t.appendAudit("user", "ad.approve", { ad_id: ad.id, plan_version: ad.plans.length, credits: estimate.credits });
        await t.enqueue("generate", { ad_id: ad.id, version: ad.version, reservation_id: reservation.id, kind: "approve" });
        return ad;
      }),
    );
  }

  async cancelAd(ctx: Ctx, id: string): Promise<Ad> {
    requireScope(ctx, "ads:create");
    return this.run(ctx.accountId, async (t) => {
      const ad = (await t.lockAd(id)) ?? (await this.requireAd(t, id));
      if (ad.status === "cancelled") return ad;
      if (TERMINAL.includes(ad.status)) throw new AdError("conflict", `Ad ${id} is already ${ad.status}.`);
      this.transition(ad, [ad.status], "cancelled");
      await t.saveAd(ad);
      await this.releaseReservations(t, ad.id);
      await t.appendAudit("user", "ad.cancel", { ad_id: ad.id });
      return ad;
    });
  }

  progress(ad: Ad): number {
    const plan = ad.plans.at(-1);
    switch (ad.status) {
      case "scripting":
        return 10;
      case "awaiting_approval":
        return 30;
      case "generating":
        return 30 + Math.round((40 * Object.keys(ad.assets).length) / (plan?.scenes.length ?? 1));
      case "rendering":
        return 70 + Math.round((29 * ad.renders.length) / (plan?.aspect_ratios.length ?? 1));
      case "completed":
        return 100;
      default:
        return 0;
    }
  }

  // ---------- results and insights ----------

  /** Ties a finished ad to the live ad it runs as on an ad platform, and records how it was launched. */
  async linkAd(
    ctx: Ctx,
    adId: string,
    input: { platform: string; platform_ad_id: string; launch_mode: string; aspect_ratio?: string; idempotency_key: string },
  ) {
    requireScope(ctx, "ads:create");
    const { idempotency_key, ...rest } = input;
    const parsed = LinkInput.safeParse(rest);
    if (!parsed.success) throw new AdError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    return this.run(ctx.accountId, (t) =>
      this.idemResult(t, ctx, "link_ad", idempotency_key, { adId, ...parsed.data }, async () => {
        await this.takeIn(t, ctx, "link_ad", this.opts.limits.linkAdPerHour, HOUR, "ad links");
        const ad = await this.requireAd(t, adId);
        if (ad.status !== "completed") throw new AdError("conflict", `An ad can be linked once its video is made, but ${adId} is "${ad.status}".`);
        const existing = await t.linksForAds([adId]);
        if (existing.length >= 10) throw new AdError("rate_limited", "An ad can be linked to at most 10 live ads.", undefined, { retry: false });
        const taken = await t.linkByPlatformAd(parsed.data.platform, parsed.data.platform_ad_id);
        if (taken) throw new AdError("conflict", `That ${parsed.data.platform} ad is already linked (to ${taken.ad_id}). One live ad belongs to one Hookmint ad.`);
        const link = { id: `lk_${randomUUID().slice(0, 8)}`, account_id: ctx.accountId, ad_id: adId, ...(parsed.data.aspect_ratio ? { aspect_ratio: parsed.data.aspect_ratio } : {}), platform: parsed.data.platform, platform_ad_id: parsed.data.platform_ad_id, launch_mode: parsed.data.launch_mode, created_at: new Date(this.opts.now()).toISOString() };
        await t.putLink(link);
        await t.appendAudit("user", "ad.link", { ad_id: adId, link_id: link.id, platform: link.platform, launch_mode: link.launch_mode });
        return { link_id: link.id, ad_id: adId, platform: link.platform, platform_ad_id: link.platform_ad_id, launch_mode: link.launch_mode, aspect_ratio: link.aspect_ratio ?? null, evidence: link.launch_mode === "separate" ? "observational" : "causal" };
      }),
    );
  }

  /**
   * Records daily results for a linked ad. A day that was reported before is corrected by reporting it again: the old
   * row stays, and the newest one is used. Nothing is ever edited or deleted.
   */
  async recordPerformance(
    ctx: Ctx,
    linkId: string,
    input: { currency: string; timezone?: string; attribution_window?: string; rows: unknown[]; idempotency_key: string },
  ) {
    requireScope(ctx, "insights:write");
    const { idempotency_key, ...rest } = input;
    const parsed = PerformanceInput.safeParse(rest);
    if (!parsed.success) throw new AdError("invalid_input", parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    const data = parsed.data;
    const today = Date.parse(new Date(this.opts.now()).toISOString().slice(0, 10));
    const dates = new Set<string>();
    for (const r of data.rows) {
      if (!isRealDate(r.date)) throw new AdError("invalid_input", `${r.date} is not a real date.`);
      const t0 = Date.parse(`${r.date}T00:00:00Z`);
      if (t0 > today + 86_400_000) throw new AdError("invalid_input", `${r.date} is in the future.`);
      if (t0 < today - 2 * 366 * 86_400_000) throw new AdError("invalid_input", `${r.date} is more than two years ago.`);
      if (dates.has(r.date)) throw new AdError("invalid_input", `${r.date} appears twice in this request. Send one row per day.`);
      dates.add(r.date);
    }
    return this.run(ctx.accountId, (t) =>
      this.idemResult(t, ctx, "record_performance", idempotency_key, { linkId, ...data }, async () => {
        await this.takeIn(t, ctx, "record_performance", this.opts.limits.recordPerformancePerHour, HOUR, "performance updates");
        const link = await t.getLink(linkId);
        if (!link) throw new AdError("not_found", `No link with id ${linkId}. Call link_ad first.`);
        const before = await t.snapshotsForLinks([linkId]);
        if (before.length + data.rows.length > 10_000) throw new AdError("rate_limited", "This link has reached its limit of 10,000 result rows.", undefined, { retry: false });
        const known = new Set(before.map((r) => r.date));
        const now = new Date(this.opts.now()).toISOString();
        await t.appendSnapshots(
          data.rows.map((r) => ({ id: `sn_${randomUUID().replace(/-/g, "").slice(0, 16)}`, account_id: ctx.accountId, link_id: linkId, date: r.date, spend: Math.round(r.spend * 100) / 100, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, currency: data.currency, timezone: data.timezone, attribution_window: data.attribution_window, metric_definition_version: METHOD_VERSION, source: "manual" as const, created_at: now })),
        );
        const sorted = [...dates].sort();
        await t.appendAudit("user", "performance.record", { link_id: linkId, days: sorted.length, first: sorted[0], last: sorted.at(-1) });
        return { link_id: linkId, days_recorded: sorted.length, first_date: sorted[0], last_date: sorted.at(-1)!, corrected_days: sorted.filter((d) => known.has(d)).length };
      }),
    );
  }

  /** Latest revision of each (link, day), optionally limited to a date range. */
  private latestRows(rows: Awaited<ReturnType<Tx["snapshotsForLinks"]>>, from?: string, to?: string) {
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latest.set(`${r.link_id}|${r.date}`, r); // oldest first, so the newest wins
    return [...latest.values()].filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  }

  private async groupReport(t: Tx, groupId: string, from?: string, to?: string): Promise<{ report: GroupReport; insights: Insight[]; links: { link_id: string; ad_id: string; platform: string; launch_mode: string }[]; brand_kit_id?: string }> {
    const group = await t.getGroup(groupId);
    if (!group) throw new AdError("not_found", `No variant group with id ${groupId}.`);
    const ads: Ad[] = [];
    for (const id of group.ad_ids) {
      const ad = await t.getAd(id);
      if (ad) ads.push(ad);
    }
    const links = await t.linksForAds(ads.map((a) => a.id));
    const rows = this.latestRows(await t.snapshotsForLinks(links.map((l) => l.id)), from, to);
    const inputs = ads.map((ad) => {
      const mine = links.filter((l) => l.ad_id === ad.id);
      const ids = new Set(mine.map((l) => l.id));
      return {
        ad_id: ad.id,
        is_base: ad.id === group.base_ad_id,
        value: testedValue(ad.plans.at(-1)!, group.tested_variable),
        launch_modes: mine.map((l) => l.launch_mode as LaunchMode),
        rows: rows.filter((r) => ids.has(r.link_id)).map((r): Snapshot & { link_id: string } => ({ link_id: r.link_id, date: r.date, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, currency: r.currency, attribution_window: r.attribution_window, timezone: r.timezone })),
      };
    });
    const report = analyzeGroup(group.tested_variable, inputs);
    return { report, insights: insightsFrom(group.id, report), links: links.map((l) => ({ link_id: l.id, ad_id: l.ad_id, platform: l.platform, launch_mode: l.launch_mode })), brand_kit_id: group.brand_kit_id };
  }

  /** How the variants of one group are doing, or a summary of every group of a brand. */
  async getPerformance(ctx: Ctx, input: { variant_group_id?: string; brand_kit_id?: string; from?: string; to?: string }) {
    requireScope(ctx, "insights:read");
    if ((input.variant_group_id === undefined) === (input.brand_kit_id === undefined)) throw new AdError("invalid_input", "Give either variant_group_id or brand_kit_id, not both and not neither.");
    for (const d of [input.from, input.to]) if (d !== undefined && !isRealDate(d)) throw new AdError("invalid_input", `${d} is not a real date like 2026-05-31.`);
    if (input.from && input.to && input.from > input.to) throw new AdError("invalid_input", "from must not be after to.");
    return this.run(ctx.accountId, async (t) => {
      if (input.variant_group_id) {
        const { report, insights, links, brand_kit_id } = await this.groupReport(t, input.variant_group_id, input.from, input.to);
        return { variant_group_id: input.variant_group_id, brand_kit_id: brand_kit_id ?? null, links, report, insights };
      }
      if (!(await t.getKit(input.brand_kit_id!))) throw new AdError("not_found", `Unknown brand_kit_id ${input.brand_kit_id}.`);
      const groups = (await t.listGroups(input.brand_kit_id)).slice(0, 50);
      const summaries = [];
      for (const g of groups) {
        const { report } = await this.groupReport(t, g.id, input.from, input.to);
        summaries.push({ variant_group_id: g.id, tested_variable: g.tested_variable, variants: report.variants.length, evidence: report.evidence, window: report.window, verdicts: { ctr: report.verdicts.ctr.status, cvr: report.verdicts.cvr.status } });
      }
      return { brand_kit_id: input.brand_kit_id!, groups: summaries };
    });
  }

  /** What a brand's finished tests have shown, as plain statements with their numbers. Says so when there is nothing to conclude. */
  async getInsights(ctx: Ctx, brandKitId: string) {
    requireScope(ctx, "insights:read");
    return this.run(ctx.accountId, (t) => this.insightsIn(t, brandKitId));
  }

  private async insightsIn(t: Tx, brandKitId: string) {
    if (!(await t.getKit(brandKitId))) throw new AdError("not_found", `Unknown brand_kit_id ${brandKitId}.`);
    const groups = (await t.listGroups(brandKitId)).slice(0, 50);
    const insights: Insight[] = [];
    let withVerdict = 0;
    for (const g of groups) {
      const { insights: found } = await this.groupReport(t, g.id);
      if (found.length) withVerdict++;
      insights.push(...found);
    }
    const status = insights.length ? "ok" : "insufficient_data";
    return {
      brand_kit_id: brandKitId,
      method_version: METHOD_VERSION,
      status,
      groups_tested: groups.length,
      groups_with_a_clear_winner: withVerdict,
      insights,
      message: insights.length
        ? "Each statement is one test on one audience. It suggests what may work; it does not prove it."
        : groups.length
          ? "No test has a clear winner yet. Either there is not enough data per variant, or the variants perform alike. See get_performance for what each one still needs."
          : "No variant tests yet. Create variants with create_variants, launch them side by side, and record their results.",
    };
  }

  /**
   * What has won controlled tests for this brand, for steering new scripts and variants. Only concluded, causal results
   * count (a test launched separately never does), at most five, strongest evidence first. Text only: no ids or numbers
   * beyond the size of the win.
   */
  private async learningsFor(t: Tx, kitId?: string): Promise<Learning[]> {
    if (!kitId) return [];
    const { insights } = await this.insightsIn(t, kitId);
    return insights
      .filter((i) => i.usable_for_generation && i.winning_value)
      .sort((a, b) => a.adjusted_p - b.adjusted_p || b.sample_size.impressions_per_variant_min - a.sample_size.impressions_per_variant_min)
      .slice(0, 5)
      .map((i) => ({ variable: i.tested_variable, metric: i.metric, winning: i.winning_value, beaten: i.beaten_values.slice(0, 3), relative_lift_percent: Math.round((i.lift_vs_runner_up.ratio - 1) * 1000) / 10 }));
  }

  /** Before launching: how much traffic a test needs to notice a difference of a given size. Pure arithmetic, no data. */
  planTest(ctx: Ctx, input: { baseline_rate: number; relative_lift: number; variants: number; power?: number; expected_daily_impressions_per_variant?: number }) {
    requireScope(ctx, "insights:read");
    const parsed = TestPlanInput.safeParse(input);
    if (!parsed.success) throw new AdError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    const p = parsed.data;
    let perVariant: number;
    try {
      perVariant = sampleSizePerVariant({ baselineRate: p.baseline_rate, relativeLift: p.relative_lift, variants: p.variants, power: p.power });
    } catch (e) {
      throw new AdError("invalid_input", e instanceof Error ? e.message : "Those numbers cannot be planned.");
    }
    return {
      method_version: METHOD_VERSION,
      per_variant: perVariant,
      total: perVariant * p.variants,
      days: p.expected_daily_impressions_per_variant ? Math.ceil(perVariant / p.expected_daily_impressions_per_variant) : null,
      assumptions: `Measured on impressions for a rate like click-through. Two-sided 5% significance, ${Math.round(p.power * 100)}% power, corrected for comparing all ${(p.variants * (p.variants - 1)) / 2} pair(s) of ${p.variants} variants. Needs about this many per variant for a ${Math.round(p.relative_lift * 100)}% relative change from a ${Math.round(p.baseline_rate * 10000) / 100}% rate. A smaller real difference will not be reliably found.`,
    };
  }

  // ---------- outbox relay and handlers (the "worker") ----------

  private kick() {
    if (!this.stopped) queueMicrotask(() => void this.relay());
  }

  /** Dispatch unfinished outbox rows. Delivery is at-least-once; handlers ignore stale or repeated work. */
  async relay(): Promise<void> {
    if (this.relaying) {
      this.again = true;
      return;
    }
    this.relaying = true;
    try {
      do {
        this.again = false;
        let rows: OutboxRow[];
        try {
          rows = await this.store.claimOutbox(50, LEASE_MS);
        } catch (err) {
          console.error("outbox claim failed", err instanceof Error ? err.message : err);
          return;
        }
        for (const row of rows) {
          const p: Promise<unknown> = this.handle(row)
            .then(() => this.store.completeOutbox(row.id))
            .catch((err) => console.error("outbox handler crashed", err instanceof Error ? err.message : err))
            .finally(() => this.inflight.delete(p));
          this.inflight.add(p);
        }
      } while (this.again);
    } finally {
      this.relaying = false;
    }
  }

  /** Test and recovery hook: make a finished row deliverable again and dispatch. */
  async redeliver(rowId: string) {
    await this.store.redeliver(rowId);
    await this.relay();
  }

  /** Waits until no handler is running. For tests. */
  async idle(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while ((this.inflight.size || this.relaying) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  }

  private async handle(row: OutboxRow) {
    if (row.topic === "logo") return this.runLogo(row.account_id, row.payload as { kit_id: string });
    if (row.topic === "semantic") return this.runSemantic(row.account_id, row.payload as { ad_id: string; plan_version: number; rule_version: number });
    const p = row.payload as { ad_id: string; version: number; reservation_id?: string; kind?: "approve" | "regen"; scene_id?: string };
    try {
      if (row.topic === "script") await this.runScript(row.account_id, p.ad_id, p.version);
      else await this.runGenerate(row.account_id, p.ad_id, p);
    } catch (err) {
      if (err instanceof Superseded) return;
      await this.failAd(row.account_id, p.ad_id, err);
    }
  }

  private async runScript(accountId: string, adId: string, v: number) {
    const start = await this.run(accountId, async (t) => {
      const ad = await t.getAd(adId);
      if (!ad || ad.version !== v || ad.status !== "scripting") return undefined; // stale or repeated delivery
      return { ad, brand: ad.brand_kit_id ? await t.getKit(ad.brand_kit_id) : undefined, rules: ad.brand_kit_id ? await t.getRules(ad.brand_kit_id) : undefined, learnings: await this.learningsFor(t, ad.brand_kit_id) };
    });
    if (!start) return;
    const { ad, brand, rules, learnings } = start;
    const raw = await this.store.providerCalls.runOnce(`${ad.account_id}:${ad.id}:script`, { provider: "script", cost_credits: 0 }, () =>
      this.providers.script.generate({ prompt: ad.prompt, duration_s: ad.duration_s, aspect_ratios: ad.aspect_ratios, brand, guidance: guidanceFor(rules, learnings) }),
    );
    const parsed = ScenePlanSchema.safeParse(upgradePlan(raw));
    if (!parsed.success) throw new AdError("invalid_input", `Script provider returned an invalid plan: ${parsed.error.message}`);
    this.checkDuration(parsed.data, ad.duration_s);
    // Attribution ids are minted here, never taken from a provider, so they are unique across accounts.
    parsed.data.hook_id = mintId("h");
    parsed.data.variant_group_id = mintId("vg");
    await this.run(accountId, async (t) => {
      const fresh = await t.lockAd(adId);
      if (!fresh || fresh.version !== v) throw new Superseded();
      fresh.plans.push(parsed.data);
      this.transition(fresh, ["scripting"], "awaiting_approval");
      await t.saveAd(fresh);
      await this.ensureSemantic(t, fresh);
    });
  }

  private async runGenerate(
    accountId: string,
    adId: string,
    p: { version: number; reservation_id?: string; kind?: "approve" | "regen"; scene_id?: string },
  ) {
    const start = await this.run(accountId, async (t) => {
      const ad = await t.getAd(adId);
      if (!ad || ad.version !== p.version || ad.status !== "generating" || !p.reservation_id) return undefined; // stale or repeated delivery
      return ad;
    });
    if (!start) return;
    let v = p.version;
    const planVersion = start.plans.length;
    const plan = this.currentPlan(start);
    const todo = p.kind === "regen" ? plan.scenes.filter((s) => s.id === p.scene_id) : plan.scenes.filter((s) => !start.assets[s.id]);

    await Promise.all(
      todo.map(async (scene) => {
        const base = `${accountId}:${adId}:${scene.id}:v${planVersion}`;
        const [visual, voice] = await Promise.all([
          this.store.providerCalls.runOnce(`${base}:visual`, { provider: "visual", cost_credits: visualCredits(scene) }, () => this.providers.visual.generate(scene)),
          this.store.providerCalls.runOnce(`${base}:voice`, { provider: "voice", cost_credits: VOICE_CREDITS }, () => this.makeVoice(accountId, scene)),
        ]);
        await this.run(accountId, async (t) => {
          const ad = await t.lockAd(adId);
          if (!ad || ad.version !== v) throw new Superseded();
          ad.assets[scene.id] = { visual_url: visual.url, voice_url: voice.url, visual_kind: visual.kind, ai_voice: voice.ai_generated };
          await t.saveAd(ad);
        });
      }),
    );

    if (p.kind === "regen") {
      await this.run(accountId, async (t) => {
        const ad = await t.lockAd(adId);
        if (!ad || ad.version !== v) throw new Superseded();
        await this.settle(t, p.reservation_id!, ad);
        this.transition(ad, ["generating"], "awaiting_approval");
        await t.saveAd(ad);
      });
      return;
    }

    const rendering = await this.run(accountId, async (t) => {
      const ad = await t.lockAd(adId);
      if (!ad || ad.version !== v) throw new Superseded();
      v = this.transition(ad, ["generating"], "rendering");
      await t.saveAd(ad);
      const kit = ad.brand_kit_id ? await t.getKit(ad.brand_kit_id) : undefined;
      return { ad, kit };
    });
    const { ad, kit } = rendering;
    const brand = kit;
    const { assets: renderAssets, notes: ingestNotes } = await this.localizeAssets(ad, plan, planVersion);
    const logoPath = kit?.logo_status === "ready" ? kit.logo_path : undefined;
    if (kit?.logo_url && kit.logo_status !== "ready") {
      ingestNotes.push(kit.logo_status === "pending" ? "The brand logo is still downloading, so this video has no logo." : `The brand logo is not available (${kit.logo_error ?? kit.logo_status}), so this video has no logo.`);
    }
    for (const aspect of plan.aspect_ratios) {
      // Deterministic, so a retry or redelivery writes the same file instead of a second one.
      const renderId = `rn_${createHash("sha256").update(`${ad.id}:${aspect}:v${planVersion}`).digest("hex").slice(0, 12)}`;
      const outputPath = this.opts.renderDir ? path.join(this.opts.renderDir, `${renderId}.mp4`) : undefined;
      const out = await this.store.providerCalls.runOnce(
        `${accountId}:${ad.id}:${aspect}:v${planVersion}:render`,
        { provider: "renderer", cost_credits: RENDER_CREDITS_PER_ASPECT },
        () => this.providers.renderer.render({ plan, aspect, assets: renderAssets, brand, logoPath, outputPath, metadata: provenance(ad, plan, planVersion) }),
      );
      try {
        await this.run(accountId, async (t) => {
          const cur = await t.lockAd(adId);
          if (!cur || cur.version !== v) throw new Superseded();
          if (cur.renders.some((r) => r.aspect_ratio === aspect)) return;
          if (out.file) {
            if (!outputPath) throw new AdError("invalid_input", "The renderer wrote a file but no renderDir is configured.");
            await t.putRender(renderId, { account_id: accountId, ad_id: adId, path: outputPath, bytes: out.file.bytes });
          }
          cur.renders.push({ render_id: renderId, aspect_ratio: aspect, stored: !!out.file, url: out.url, bytes: out.file?.bytes, duration_s: out.file?.duration_s, notes: [...ingestNotes, ...(out.notes ?? [])], renderer_version: out.renderer_version });
          await t.saveAd(cur);
        });
      } catch (err) {
        if (err instanceof Superseded && outputPath && out.file) await fsp.rm(outputPath, { force: true }); // cancelled while rendering: do not keep the file
        throw err;
      }
    }
    await this.run(accountId, async (t) => {
      await t.lockAccount();
      const cur = await t.lockAd(adId);
      if (!cur || cur.version !== v) throw new Superseded();
      await this.settle(t, p.reservation_id!, cur);
      this.transition(cur, ["rendering"], "completed");
      await t.saveAd(cur);
    });
  }

  // ---------- finished videos ----------

  /** What clients see for each render: a fresh short-lived link (never a stored one), size, and any notes. */
  private async renderViews(t: Tx, ad: Ad) {
    const out = [];
    for (const r of ad.renders) {
      const link = r.stored ? this.downloads.sign(ad.account_id, r.render_id) : null;
      out.push({
        render_id: r.render_id,
        aspect_ratio: r.aspect_ratio,
        url: link?.url ?? r.url ?? null,
        expires_at: link?.expires_at ?? null,
        bytes: r.bytes ?? null,
        duration_s: r.duration_s ?? null,
        notes: r.notes ?? [],
        renderer_version: r.renderer_version ?? null,
        ...(this.opts.exposeLocalPaths && r.stored ? { local_path: (await t.getRender(r.render_id))?.path } : {}),
      });
    }
    return out;
  }

  /** A new link for a render, for when an earlier one has expired. */
  async downloadUrl(ctx: Ctx, renderId: string): Promise<SignedLink & { render_id: string }> {
    requireScope(ctx, "ads:read");
    const rec = await this.run(ctx.accountId, (t) => t.getRender(renderId));
    if (!rec) throw new AdError("not_found", `No render with id ${renderId}.`);
    return { render_id: renderId, ...this.downloads.sign(ctx.accountId, renderId) };
  }

  /** For the file route. The signature is the authorisation, so this also checks the render belongs to that account. */
  async renderFile(renderId: string, accountId: string): Promise<{ path: string; bytes: number } | null> {
    const rec = await this.run(accountId, (t) => t.getRender(renderId));
    return rec ? { path: rec.path, bytes: rec.bytes } : null;
  }

  /**
   * Asks the voice provider for a scene's voiceover. A provider that answers with the audio itself has it stored
   * through the media ingestor (checked like any download), so the stored result is always a small address, never audio.
   * Without an asset folder there is nowhere to keep it, so the scene is silent and the render notes say so.
   */
  private async makeVoice(accountId: string, scene: Scene): Promise<{ url: string; provider: string; ai_generated?: boolean }> {
    const r = await this.providers.voice.generate(scene);
    if ("url" in r) return r;
    const ing = this.opts.ingestor;
    if (!ing) return { url: "none:no-asset-folder", provider: r.provider, ai_generated: r.ai_generated };
    return { url: pathToFileURL(await ing.audioBytes(accountId, r.audio, r.format)).href, provider: r.provider, ai_generated: r.ai_generated };
  }

  /**
   * Turns remote media addresses into local files the renderer may read. A download that fails is not an error for
   * the ad: that scene falls back to the brand gradient and the render notes say why. Local files pass through.
   */
  private async localizeAssets(ad: Ad, plan: ScenePlan, planVersion: number) {
    const out: Record<string, { visual_url: string; voice_url: string }> = {};
    const notes: string[] = [];
    const ing = this.opts.ingestor;
    const fetchOnce = (scene: string, what: "visual" | "voice", url: string, get: () => Promise<string>) =>
      this.store.providerCalls.runOnce(`${ad.account_id}:${ad.id}:${scene}:v${planVersion}:ingest:${what}:${createHash("sha256").update(url).digest("hex").slice(0, 12)}`, { provider: "ingest", cost_credits: 0 }, get);
    for (const scene of plan.scenes) {
      const a = ad.assets[scene.id];
      if (!a) continue;
      let visual = a.visual_url;
      let voice = a.voice_url;
      if (ing && visual.startsWith("https://")) {
        const url = visual;
        const kind = a.visual_kind ?? (scene.visual_source === "video_gen" ? "video" : "image");
        try {
          visual = pathToFileURL(await fetchOnce(scene.id, "visual", url, () => (kind === "video" ? ing.video(ad.account_id, url) : ing.image(ad.account_id, url)))).href;
        } catch (err) {
          notes.push(`Scene ${scene.id}: the visual could not be downloaded (${err instanceof AdError ? err.message : "unexpected error"}); the brand gradient was used instead.`);
        }
      }
      if (ing && voice.startsWith("https://")) {
        const url = voice;
        try {
          voice = pathToFileURL(await fetchOnce(scene.id, "voice", url, () => ing.audio(ad.account_id, url))).href;
        } catch (err) {
          notes.push(`Scene ${scene.id}: the voiceover could not be downloaded (${err instanceof AdError ? err.message : "unexpected error"}); that part is silent.`);
        }
      }
      out[scene.id] = { visual_url: visual, voice_url: voice };
    }
    if (Object.values(ad.assets).some((a) => a.ai_voice)) notes.push("The voiceover is AI-generated. Tell viewers where the platform or the voice provider's rules require it.");
    for (const scene of plan.scenes) if (ad.assets[scene.id]?.voice_url.startsWith("none:")) notes.push(`Scene ${scene.id}: a voiceover was made but there is no asset folder to keep it in, so that part is silent.`);
    return { assets: out, notes };
  }

  // ---------- internals ----------

  private async requireAd(t: Tx, id: string): Promise<Ad> {
    const ad = await t.getAd(id);
    if (!ad) throw new AdError("not_found", `No ad with id ${id}.`);
    return ad;
  }

  private async requireStatus(t: Tx, id: string, status: JobStatus, tool: string, lock = false): Promise<Ad> {
    const ad = lock ? await t.lockAd(id) : await t.getAd(id);
    if (!ad) throw new AdError("not_found", `No ad with id ${id}.`);
    if (ad.status !== status) {
      throw new AdError("conflict", `${tool} needs status "${status}" but ad ${id} is "${ad.status}".`);
    }
    return ad;
  }

  private currentPlan(ad: Ad): ScenePlan {
    const plan = ad.plans.at(-1);
    if (!plan) throw new AdError("conflict", "The script is not ready yet. Poll get_ad_status.");
    return plan;
  }

  /** Version-checked state change on a loaded ad. Returns the new version. The caller saves the ad. */
  private transition(ad: Ad, from: JobStatus[], to: JobStatus): number {
    if (!from.includes(ad.status)) {
      throw new AdError("conflict", `Ad ${ad.id} is "${ad.status}", expected ${from.join(" or ")}.`);
    }
    ad.status = to;
    return ++ad.version;
  }

  private async failAd(accountId: string, adId: string, err: unknown) {
    await this.run(accountId, async (t) => {
      const ad = await t.lockAd(adId);
      if (!ad || TERMINAL.includes(ad.status)) return;
      ad.error = err instanceof Error ? err.message : String(err);
      ad.status = "failed";
      ad.version++;
      await t.saveAd(ad);
      await this.releaseReservations(t, ad.id);
      await t.appendAudit("system", "ad.failed", { ad_id: ad.id, error: ad.error });
    });
  }

  private async reserve(t: Tx, ctx: Ctx, ad: Ad, estimate: Estimate, maxCredits: number): Promise<Reservation> {
    if (estimate.credits > maxCredits) {
      throw new AdError("invalid_input", `Estimate is ${estimate.credits} credits, above max_credits ${maxCredits}.`);
    }
    await t.lockAccount(); // nobody else can spend this account's credits until this transaction ends
    const { available } = await this.balanceOf(t);
    if (available < estimate.credits) {
      throw new AdError("insufficient_credits", `Needs ${estimate.credits} credits but ${available} are available.`);
    }
    const r: Reservation = { id: randomUUID(), account_id: ctx.accountId, ad_id: ad.id, amount: estimate.credits, status: "held" };
    await t.putReservation(r);
    return r;
  }

  private async settle(t: Tx, reservationId: string, ad: Ad) {
    const r = await t.getReservation(reservationId);
    if (!r || r.status !== "held") return;
    await t.putReservation({ ...r, status: "settled" });
    await t.addLedger({ id: randomUUID(), ad_id: ad.id, delta: -r.amount, reason: "render" });
  }

  private async releaseReservations(t: Tx, adId: string) {
    for (const r of await t.reservationsForAd(adId)) if (r.status === "held") await t.putReservation({ ...r, status: "released" });
  }

  private checkDuration(plan: ScenePlan, target: number) {
    const total = totalDuration(plan);
    if (Math.abs(total - target) > 1) {
      throw new AdError("invalid_input", `Scene durations add up to ${total}s but the ad must be ${target}s (±1s).`);
    }
  }

  /** Same idea as `idem` for requests whose answer is not an ad: a repeat returns the stored answer. */
  private async idemResult<T>(t: Tx, ctx: Ctx, tool: string, key: string, args: unknown, run: () => Promise<T>): Promise<T> {
    const k = `${ctx.accountId}:${key}`;
    const hash = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex");
    await t.lockKey(`idem:${k}`);
    const prior = await t.getIdem(k);
    if (prior) {
      if (prior.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
      return prior.result as T;
    }
    const out = await run();
    await t.putIdem(k, { hash, ad_id: "", result: out });
    return out;
  }

  /** Same key + same request returns the original ad; same key + different request is a conflict. */
  private async idem(t: Tx, ctx: Ctx, tool: string, key: string, args: unknown, run: () => Promise<Ad>): Promise<Ad> {
    const k = `${ctx.accountId}:${key}`;
    const hash = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex");
    await t.lockKey(`idem:${k}`); // a second request with this key waits here and then sees the first one's result
    const prior = await t.getIdem(k);
    if (prior) {
      if (prior.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
      return this.requireAd(t, prior.ad_id);
    }
    const ad = await run();
    await t.putIdem(k, { hash, ad_id: ad.id });
    return ad;
  }
}
