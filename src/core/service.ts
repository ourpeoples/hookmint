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
import { type Ad, MemoryStore, type OutboxRow, type Reservation, type StoredKit } from "./store.js";
import type { MediaIngestor } from "../net/ingest.js";
import type { Providers } from "../providers/types.js";

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

const guidanceFor = (set?: RuleSet) => (set ? { rules: set.rules.map((r) => ({ type: r.type, pattern: r.pattern })), examples: set.examples } : undefined);

/** Short unique id with a readable prefix, e.g. h_3fa9c01b22de (hex only, no separators). */
const mintId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Thrown inside a handler when another writer moved the job on (cancel, redelivery). Not an error. */
class Superseded extends Error {}

/**
 * The single service layer. MCP tools and REST routes both call this; neither contains business logic.
 * State changes are version-checked, work is handed to workers through an outbox, spend goes through
 * reservations, and each provider call runs at most once per key.
 */
export class AdService {
  readonly store: MemoryStore;
  /** Providers whose circuit breaker is open, for the readiness report. */
  openBreakers(): string[] {
    return this.store.providerCalls.openBreakers();
  }
  /** "memory" means state is lost on restart. Readiness reports it so a deploy cannot mistake it for durable. */
  get storeKind(): "memory" {
    return "memory";
  }
  private opts: ServiceOptions;
  readonly downloads: DownloadSigner;
  private limiter: RateLimiter;
  private variantsInFlight = new Map<string, { hash: string; promise: Promise<VariantResult> }>();

  constructor(private providers: Providers, opts: Partial<ServiceOptions> = {}, store?: MemoryStore) {
    this.opts = { regenBudget: 3, retryBaseMs: 200, maxVariantsPerBase: 10, minVariantDistance: DEFAULT_MIN_DISTANCE, downloads: new DownloadSigner(), exposeLocalPaths: false, limits: DEFAULT_LIMITS, now: Date.now, ...opts };
    this.downloads = this.opts.downloads;
    this.limiter = new RateLimiter(this.opts.now);
    this.store = store ?? new MemoryStore(this.opts.retryBaseMs);
  }

  // ---------- limits ----------

  get limits(): Limits {
    return this.opts.limits;
  }

  /** Counts one request against the account's per-minute allowance. Both transports call this. */
  admit(ctx: Ctx): void {
    this.limiter.take(ctx.accountId, "requests", this.opts.limits.requestsPerMinute, MINUTE, { label: "requests" });
  }

  private take(ctx: Ctx, key: string, limit: number, windowMs: number, label: string, weight = 1) {
    this.limiter.take(ctx.accountId, key, limit, windowMs, { label, weight });
  }

  /** Videos being generated or rendered right now. One account cannot fill the queue for everyone. */
  private assertRoomForJob(ctx: Ctx) {
    const active = [...this.store.ads.values()].filter((a) => a.account_id === ctx.accountId && (a.status === "generating" || a.status === "rendering")).length;
    if (active >= this.opts.limits.maxActiveJobs) {
      throw new AdError("rate_limited", `${active} of your videos are being made right now, which is the most allowed at once. Try again when one finishes.`, 30, { retry: false });
    }
  }

  // ---------- accounts and credits ----------

  /** Invite-only v1: credits are granted manually by an operator. */
  grantCredits(accountId: string, amount: number, reason: string) {
    this.store.ledger.push({ id: randomUUID(), account_id: accountId, delta: amount, reason });
    this.store.appendAudit(accountId, "operator", "credits.grant", { amount, reason });
  }

  getBalance(ctx: Ctx) {
    return { available: this.store.available(ctx.accountId), held: this.store.held(ctx.accountId) };
  }

  // ---------- brand kits ----------

  /**
   * A logo address is checked straight away (https, public, no credentials) and then downloaded in the background,
   * so the call returns at once and `logo_status` moves from "pending" to "ready" or "failed".
   */
  createBrandKit(ctx: Ctx, input: Omit<BrandKit, "id">): BrandKit & { logo_status: StoredKit["logo_status"] } {
    requireScope(ctx, "brand:write");
    this.take(ctx, "create_brand_kit", this.opts.limits.createBrandKitPerHour, HOUR, "brand kits");
    if (input.logo_url && this.opts.ingestor) {
      const pending = [...this.store.brandKits.values()].filter((k) => k.account_id === ctx.accountId && k.logo_status === "pending").length;
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
    this.store.brandKits.set(kit.id, kit);
    if (kit.logo_status === "pending") this.enqueue("logo", { kit_id: kit.id });
    return this.publicKit(kit);
  }

  getBrandKit(ctx: Ctx, id: string) {
    requireScope(ctx, "brand:read");
    const kit = this.store.brandKits.get(id);
    if (!kit || kit.account_id !== ctx.accountId) throw new AdError("not_found", `Unknown brand_kit_id ${id}.`);
    return { ...this.publicKit(kit), rule_set_version: this.store.brandRules.get(id)?.version ?? null };
  }

  private publicKit(kit: StoredKit) {
    const { account_id: _a, logo_path: _p, logo_error, ...rest } = kit;
    return { ...rest, ...(logo_error ? { logo_error } : {}) };
  }

  private async runLogo(p: { kit_id: string }) {
    const kit = this.store.brandKits.get(p.kit_id);
    if (!kit || kit.logo_status !== "pending" || !kit.logo_url || !this.opts.ingestor) return; // stale or repeated delivery
    const ingestor = this.opts.ingestor;
    const url = kit.logo_url;
    try {
      const got = await this.store.providerCalls.runOnce(`${kit.account_id}:${kit.id}:logo:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`, { provider: "logo", cost_credits: 0 }, () => ingestor.logo(kit.account_id, kit.id, url));
      kit.logo_status = "ready";
      kit.logo_path = got.path;
      delete kit.logo_error;
    } catch (err) {
      kit.logo_status = "failed";
      kit.logo_error = err instanceof AdError ? err.message : "The logo could not be downloaded.";
    }
  }

  /** Replaces the whole rule set for a brand kit. Each save is a new version; findings record the version they used. */
  setBrandRules(ctx: Ctx, kitId: string, input: { rules: RuleInput[]; examples?: ExampleInput[] }) {
    requireScope(ctx, "brand:write");
    this.take(ctx, "set_brand_rules", this.opts.limits.setBrandRulesPerHour, HOUR, "rule changes");
    const kit = this.store.brandKits.get(kitId);
    if (!kit || kit.account_id !== ctx.accountId) throw new AdError("not_found", `Unknown brand_kit_id ${kitId}.`);
    const rules = buildRules(input.rules);
    const version = (this.store.brandRules.get(kitId)?.version ?? 0) + 1;
    this.store.brandRules.set(kitId, { account_id: ctx.accountId, version, rules, examples: input.examples ?? [] });
    this.store.appendAudit(ctx.accountId, "user", "brand.rules.set", { brand_kit_id: kitId, version, rule_count: rules.length });
    for (const ad of this.store.ads.values()) {
      if (ad.account_id === ctx.accountId && ad.brand_kit_id === kitId && ad.status === "awaiting_approval") this.ensureSemantic(ad);
    }
    return { brand_kit_id: kitId, version, rule_count: rules.length, example_count: (input.examples ?? []).length };
  }

  /**
   * Findings for the ad's current plan against the brand kit's current rules: deterministic ones computed now, plus
   * cached model-based ones for this exact plan and rule version. Model findings are advisory and never block.
   */
  findingsFor(ad: Ad): { findings: Finding[]; rule_set_version: number | null; semantic: { status: SemanticStatus; discarded: number } } {
    const plan = ad.plans.at(-1);
    const set = ad.brand_kit_id ? this.store.brandRules.get(ad.brand_kit_id) : undefined;
    if (!plan || !set) return { findings: [], rule_set_version: set?.version ?? null, semantic: { status: "none", discarded: 0 } };
    const findings = checkPlan(plan, set.rules, set.version);
    let semantic: { status: SemanticStatus; discarded: number } = { status: "none", discarded: 0 };
    if (set.rules.some((r) => r.type === "semantic")) {
      const hit = this.store.semantic.get(semanticKey(ad.id, ad.plans.length, set.version));
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
  private ensureSemantic(ad: Ad) {
    if (!this.providers.semantic || !ad.plans.length) return;
    const set = ad.brand_kit_id ? this.store.brandRules.get(ad.brand_kit_id) : undefined;
    if (!set || !set.rules.some((r) => r.type === "semantic")) return;
    const key = semanticKey(ad.id, ad.plans.length, set.version);
    if (this.store.semantic.has(key) || this.store.semanticPending.has(key)) return;
    this.store.semanticPending.add(key);
    this.enqueue("semantic", { ad_id: ad.id, plan_version: ad.plans.length, rule_version: set.version });
  }

  private async runSemantic(p: { ad_id: string; plan_version: number; rule_version: number }) {
    const ad = this.store.ads.get(p.ad_id);
    const key = semanticKey(p.ad_id, p.plan_version, p.rule_version);
    try {
      if (!ad || !this.providers.semantic || this.store.semantic.has(key)) return;
      const set = ad.brand_kit_id ? this.store.brandRules.get(ad.brand_kit_id) : undefined;
      const plan = ad.plans[p.plan_version - 1];
      if (!set || set.version !== p.rule_version || !plan) return; // stale: rules or plan moved on
      try {
        const raw = await this.store.providerCalls.runOnce(`${ad.account_id}:${key}:semantic`, { provider: "semantic", cost_credits: 0 }, () =>
          this.providers.semantic!.check({ plan, rules: set.rules }),
        );
        const { findings, discarded } = validateSemantic(raw, plan, set.rules, set.version);
        this.store.semantic.set(key, { status: "done", findings, discarded });
      } catch (err) {
        this.store.semantic.set(key, { status: "unavailable", findings: [], discarded: 0, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.store.semanticPending.delete(key);
    }
  }

  checkAd(ctx: Ctx, id: string) {
    requireScope(ctx, "ads:read");
    const ad = this.requireAd(ctx, id);
    if (!ad.plans.length) throw new AdError("conflict", "The script is not ready yet. Poll get_ad_status.");
    this.ensureSemantic(ad);
    const { findings, rule_set_version, semantic } = this.findingsFor(ad);
    return { plan_version: ad.plans.length, rule_set_version, semantic_status: semantic.status, semantic_discarded: semantic.discarded, ...summarize(findings), findings };
  }

  // ---------- ads ----------

  createAd(
    ctx: Ctx,
    input: { prompt: string; brand_kit_id?: string; duration_s: number; aspect_ratios: AspectRatio[]; idempotency_key: string },
  ): Ad {
    requireScope(ctx, "ads:create");
    const { idempotency_key, ...args } = input;
    return this.idem(ctx, "create_ad", idempotency_key, args, () => {
      this.take(ctx, "create_ad", this.opts.limits.createAdPerHour, HOUR, "new ads");
      if (args.brand_kit_id) {
        const kit = this.store.brandKits.get(args.brand_kit_id);
        if (!kit || kit.account_id !== ctx.accountId) {
          throw new AdError("not_found", `Unknown brand_kit_id ${args.brand_kit_id}. Call create_brand_kit first.`);
        }
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
      this.store.ads.set(ad.id, ad);
      this.enqueue("script", { ad_id: ad.id, version: ad.version });
      return ad;
    });
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

    const prior = this.store.idempotency.get(k);
    if (prior) {
      if (prior.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
      return this.variantResult(ctx, prior.group_id!, prior.ad_id, prior.result_ad_ids!);
    }
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
    const base = this.requireAd(ctx, id);
    if (base.status !== "awaiting_approval" && base.status !== "completed") {
      throw new AdError("conflict", `create_variants needs a ready or finished ad, but ${id} is "${base.status}".`);
    }
    const basePlan = this.currentPlan(base);
    const groupId = basePlan.variant_group_id;
    this.take(ctx, "create_variants", this.opts.limits.createVariantsPerHour, HOUR, "variants", input.count); // a replay never reaches here
    const known = this.store.variantGroups.get(groupId);
    if (known && known.tested_variable !== input.tested_variable) {
      throw new AdError("conflict", `This ad's variant group already tests "${known.tested_variable}". One group tests one variable, so create variants of a different ad to test "${input.tested_variable}".`);
    }
    const brand = base.brand_kit_id ? this.store.brandKits.get(base.brand_kit_id) : undefined;
    // Keyed on the idempotency key: a retry of this request reuses the result, a new request never does.
    const callKey = `${idemKey}:variants:${base.id}`;
    const raw = await this.store.providerCalls.runOnce(callKey, { provider: "variants", cost_credits: 0 }, () =>
      this.providers.variants.generate({
        basePlan,
        tested_variable: input.tested_variable,
        count: input.count,
        brand,
        existing: (known?.ad_ids ?? [base.id]).map((x) => this.store.ads.get(x)!.plans.at(-1)!),
      }),
    );

    // Everything below is synchronous, so the group cannot change between these checks and the writes.
    const group = this.store.variantGroups.get(groupId) ?? { id: groupId, account_id: ctx.accountId, brand_kit_id: base.brand_kit_id, tested_variable: input.tested_variable, base_ad_id: base.id, ad_ids: [base.id] };
    if (group.tested_variable !== input.tested_variable) throw new AdError("conflict", `This ad's variant group already tests "${group.tested_variable}".`);
    if (group.ad_ids.length - 1 + input.count > this.opts.maxVariantsPerBase) {
      throw new AdError("rate_limited", `An ad can have at most ${this.opts.maxVariantsPerBase} variants; this one has ${group.ad_ids.length - 1}.`, undefined, { retry: false });
    }
    if (raw.length !== input.count) throw new AdError("invalid_input", `The variant provider returned ${raw.length} plan(s) for ${input.count} requested.`);

    const seen = group.ad_ids.map((x) => ({ label: x === base.id ? "the base" : `variant ${x}`, fp: fingerprint(this.store.ads.get(x)!.plans.at(-1)!, input.tested_variable, basePlan) }));
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

    const created = accepted.map(({ plan }) => {
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
      this.store.ads.set(ad.id, ad);
      group.ad_ids.push(ad.id);
      this.ensureSemantic(ad);
      return ad;
    });
    this.store.variantGroups.set(groupId, group);
    const ids = created.map((a) => a.id);
    this.store.idempotency.set(idemKey, { hash, ad_id: base.id, group_id: groupId, result_ad_ids: ids });
    this.store.appendAudit(ctx.accountId, "user", "variants.create", { base_ad_id: base.id, variant_group_id: groupId, tested_variable: input.tested_variable, ad_ids: ids });
    return this.variantResult(ctx, groupId, base.id, ids);
  }

  private variantResult(ctx: Ctx, groupId: string, baseId: string, adIds: string[]): VariantResult {
    const group = this.store.variantGroups.get(groupId)!;
    return {
      variant_group_id: groupId,
      tested_variable: group.tested_variable as TestedVariable,
      base_ad_id: baseId,
      variants: adIds.map((x) => {
        const ad = this.requireAd(ctx, x);
        return { ad, diff: ad.plans[0].variant!.diff, check: summarize(this.findingsFor(ad).findings) };
      }),
    };
  }

  getAd(ctx: Ctx, id: string): Ad {
    requireScope(ctx, "ads:read");
    return this.requireAd(ctx, id);
  }

  listAds(ctx: Ctx, limit: number): Ad[] {
    requireScope(ctx, "ads:read");
    return [...this.store.ads.values()]
      .filter((a) => a.account_id === ctx.accountId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  estimateCost(ctx: Ctx, id: string): Estimate & { balance: { available: number; held: number } } {
    requireScope(ctx, "ads:read");
    const ad = this.requireAd(ctx, id);
    const plan = this.currentPlan(ad);
    return { ...estimateApproval(plan, new Set(Object.keys(ad.assets))), balance: this.getBalance(ctx) };
  }

  /** Free animatic: timing and captions per scene. No provider is called. */
  getStoryboard(ctx: Ctx, id: string) {
    requireScope(ctx, "ads:read");
    const ad = this.requireAd(ctx, id);
    const plan = this.currentPlan(ad);
    let t = 0;
    const frames = plan.scenes.map((s) => {
      const frame = { scene_id: s.id, start_s: t, duration_s: s.duration_s, caption: s.on_screen_text ?? s.voiceover };
      t += s.duration_s;
      return frame;
    });
    return {
      plan_version: ad.plans.length,
      url: `https://example.invalid/storyboards/${ad.id}/v${ad.plans.length}`,
      total_s: t,
      frames,
    };
  }

  updateScript(ctx: Ctx, id: string, edits: ScriptEdits): Ad {
    requireScope(ctx, "ads:create");
    const ad = this.requireStatus(ctx, id, "awaiting_approval", "update_script");
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
    this.ensureSemantic(ad);
    return ad;
  }

  /** Spends credits, so it needs the same gate as approval. Without `confirm` it only returns an estimate. */
  regenerateScene(
    ctx: Ctx,
    id: string,
    input: { scene_id: string; instruction: string; confirm?: boolean; max_credits?: number; idempotency_key: string },
  ): { ad: Ad; estimate: Estimate; started: boolean } {
    requireScope(ctx, "ads:create", "spend");
    const ad = this.requireStatus(ctx, id, "awaiting_approval", "regenerate_scene");
    const scene = this.currentPlan(ad).scenes.find((s) => s.id === input.scene_id);
    if (!scene) throw new AdError("invalid_input", `Unknown scene_id ${input.scene_id}.`);
    const estimate = estimateRegeneration(scene);
    if (!input.confirm) return { ad, estimate, started: false };
    if (input.max_credits === undefined) throw new AdError("invalid_input", "max_credits is required when confirm is true.");

    const { idempotency_key, confirm: _c, ...args } = input;
    let started = false;
    const result = this.idem(ctx, "regenerate_scene", idempotency_key, { id, ...args }, () => {
      if (ad.regenerations >= this.opts.regenBudget) {
        throw new AdError("rate_limited", `This ad used its ${this.opts.regenBudget} scene regenerations.`, undefined, { retry: false });
      }
      this.assertRoomForJob(ctx);
      this.take(ctx, "spend", this.opts.limits.spendActionsPerHour, HOUR, "paid actions");
      const reservation = this.reserve(ctx, ad, estimate, input.max_credits!);
      const plan = structuredClone(this.currentPlan(ad));
      const target = plan.scenes.find((s) => s.id === input.scene_id)!;
      target.visual_prompt = `${target.visual_prompt} | Revision: ${input.instruction}`;
      ad.plans.push(plan);
      this.ensureSemantic(ad);
      delete ad.assets[input.scene_id];
      ad.regenerations++;
      this.transition(ad, ["awaiting_approval"], "generating");
      this.store.appendAudit(ctx.accountId, "user", "scene.regenerate", { ad_id: ad.id, scene_id: input.scene_id, credits: estimate.credits });
      this.enqueue("generate", { ad_id: ad.id, version: ad.version, reservation_id: reservation.id, kind: "regen", scene_id: input.scene_id });
      started = true;
      return ad;
    });
    return { ad: result, estimate, started };
  }

  approveAndRender(ctx: Ctx, id: string, input: { max_credits: number; idempotency_key: string; override_reason?: string }): Ad {
    requireScope(ctx, "ads:approve", "spend");
    const { idempotency_key, ...args } = input;
    return this.idem(ctx, "approve_and_render", idempotency_key, { id, ...args }, () => {
      const ad = this.requireStatus(ctx, id, "awaiting_approval", "approve_and_render");
      const plan = this.currentPlan(ad);
      const blocking = this.findingsFor(ad).findings.filter((f) => f.severity === "block");
      if (blocking.length && !input.override_reason) {
        const ids = [...new Set(blocking.map((f) => f.rule_id))].join(", ");
        throw new AdError("blocked_by_rule", `${blocking.length} blocking finding(s) from rule(s) ${ids}. Fix the script (see check_ad) or pass override_reason.`);
      }
      this.assertRoomForJob(ctx);
      this.take(ctx, "spend", this.opts.limits.spendActionsPerHour, HOUR, "paid actions");
      const estimate = estimateApproval(plan, new Set(Object.keys(ad.assets)));
      const reservation = this.reserve(ctx, ad, estimate, input.max_credits);
      this.transition(ad, ["awaiting_approval"], "generating");
      if (blocking.length) {
        this.store.appendAudit(ctx.accountId, "user", "ad.override", {
          ad_id: ad.id,
          plan_version: ad.plans.length,
          reason: input.override_reason,
          findings: blocking.map((f) => ({ rule_id: f.rule_id, rule_version: f.rule_version, scene_id: f.scene_id, field: f.field, evidence_quote: f.evidence_quote })),
        });
      }
      this.store.appendAudit(ctx.accountId, "user", "ad.approve", { ad_id: ad.id, plan_version: ad.plans.length, credits: estimate.credits });
      this.enqueue("generate", { ad_id: ad.id, version: ad.version, reservation_id: reservation.id, kind: "approve" });
      return ad;
    });
  }

  cancelAd(ctx: Ctx, id: string): Ad {
    requireScope(ctx, "ads:create");
    const ad = this.requireAd(ctx, id);
    if (ad.status === "cancelled") return ad;
    if (TERMINAL.includes(ad.status)) throw new AdError("conflict", `Ad ${id} is already ${ad.status}.`);
    this.transition(ad, [ad.status], "cancelled");
    this.releaseReservations(ad.id);
    this.store.appendAudit(ctx.accountId, "user", "ad.cancel", { ad_id: ad.id });
    return ad;
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

  // ---------- outbox relay and handlers (the "worker") ----------

  /** Dispatch unsent outbox rows. Delivery is at-least-once; handlers ignore stale or repeated work. */
  relay() {
    for (const row of this.store.outbox.filter((r) => !r.sent_at)) {
      row.sent_at = new Date().toISOString();
      void this.handle(row).catch((err) => console.error("outbox handler crashed", err));
    }
  }

  /** Test and recovery hook: mark a row unsent and dispatch again. */
  redeliver(rowId: string) {
    const row = this.store.outbox.find((r) => r.id === rowId);
    if (row) delete row.sent_at;
    this.relay();
  }

  private enqueue(topic: OutboxRow["topic"], payload: Record<string, unknown>) {
    this.store.outbox.push({ id: randomUUID(), topic, payload, created_at: new Date().toISOString() });
    queueMicrotask(() => this.relay());
  }

  private async handle(row: OutboxRow) {
    if (row.topic === "logo") return this.runLogo(row.payload as { kit_id: string });
    if (row.topic === "semantic") return this.runSemantic(row.payload as { ad_id: string; plan_version: number; rule_version: number });
    const p = row.payload as { ad_id: string; version: number; reservation_id?: string; kind?: "approve" | "regen"; scene_id?: string };
    const ad = this.store.ads.get(p.ad_id);
    if (!ad || ad.version !== p.version) return; // stale or repeated delivery
    try {
      if (row.topic === "script") await this.runScript(ad, p.version);
      else await this.runGenerate(ad, p);
    } catch (err) {
      if (err instanceof Superseded) return;
      this.failAd(ad, err);
    }
  }

  private async runScript(ad: Ad, v: number) {
    if (ad.status !== "scripting") return;
    const brand = ad.brand_kit_id ? this.store.brandKits.get(ad.brand_kit_id) : undefined;
    const key = `${ad.account_id}:${ad.id}:script`;
    const raw = await this.store.providerCalls.runOnce(key, { provider: "script", cost_credits: 0 }, () =>
      this.providers.script.generate({
        prompt: ad.prompt,
        duration_s: ad.duration_s,
        aspect_ratios: ad.aspect_ratios,
        brand,
        guidance: guidanceFor(ad.brand_kit_id ? this.store.brandRules.get(ad.brand_kit_id) : undefined),
      }),
    );
    this.assertCurrent(ad, v);
    const parsed = ScenePlanSchema.safeParse(upgradePlan(raw));
    if (!parsed.success) throw new AdError("invalid_input", `Script provider returned an invalid plan: ${parsed.error.message}`);
    this.checkDuration(parsed.data, ad.duration_s);
    // Attribution ids are minted here, never taken from a provider, so they are unique across accounts.
    parsed.data.hook_id = mintId("h");
    parsed.data.variant_group_id = mintId("vg");
    ad.plans.push(parsed.data);
    this.transition(ad, ["scripting"], "awaiting_approval");
    this.ensureSemantic(ad);
  }

  private async runGenerate(
    ad: Ad,
    p: { version: number; reservation_id?: string; kind?: "approve" | "regen"; scene_id?: string },
  ) {
    if (ad.status !== "generating" || !p.reservation_id) return;
    let v = p.version;
    const planVersion = ad.plans.length;
    const plan = this.currentPlan(ad);
    const todo = p.kind === "regen" ? plan.scenes.filter((s) => s.id === p.scene_id) : plan.scenes.filter((s) => !ad.assets[s.id]);

    await Promise.all(
      todo.map(async (scene) => {
        const base = `${ad.account_id}:${ad.id}:${scene.id}:v${planVersion}`;
        const [visual, voice] = await Promise.all([
          this.store.providerCalls.runOnce(`${base}:visual`, { provider: "visual", cost_credits: visualCredits(scene) }, () => this.providers.visual.generate(scene)),
          this.store.providerCalls.runOnce(`${base}:voice`, { provider: "voice", cost_credits: VOICE_CREDITS }, () => this.makeVoice(ad.account_id, scene)),
        ]);
        this.assertCurrent(ad, v);
        ad.assets[scene.id] = { visual_url: visual.url, voice_url: voice.url, visual_kind: visual.kind, ai_voice: voice.ai_generated };
      }),
    );
    this.assertCurrent(ad, v);

    if (p.kind === "regen") {
      this.settle(p.reservation_id, ad);
      this.transition(ad, ["generating"], "awaiting_approval");
      return;
    }

    v = this.transition(ad, ["generating"], "rendering");
    const brand = ad.brand_kit_id ? this.store.brandKits.get(ad.brand_kit_id) : undefined;
    const { assets: renderAssets, notes: ingestNotes } = await this.localizeAssets(ad, plan, planVersion);
    this.assertCurrent(ad, v);
    const kit = ad.brand_kit_id ? this.store.brandKits.get(ad.brand_kit_id) : undefined;
    const logoPath = kit?.logo_status === "ready" ? kit.logo_path : undefined;
    if (kit?.logo_url && kit.logo_status !== "ready") {
      ingestNotes.push(kit.logo_status === "pending" ? "The brand logo is still downloading, so this video has no logo." : `The brand logo is not available (${kit.logo_error ?? kit.logo_status}), so this video has no logo.`);
    }
    for (const aspect of plan.aspect_ratios) {
      // Deterministic, so a retry or redelivery writes the same file instead of a second one.
      const renderId = `rn_${createHash("sha256").update(`${ad.id}:${aspect}:v${planVersion}`).digest("hex").slice(0, 12)}`;
      const outputPath = this.opts.renderDir ? path.join(this.opts.renderDir, `${renderId}.mp4`) : undefined;
      const out = await this.store.providerCalls.runOnce(
        `${ad.account_id}:${ad.id}:${aspect}:v${planVersion}:render`,
        { provider: "renderer", cost_credits: RENDER_CREDITS_PER_ASPECT },
        () => this.providers.renderer.render({ plan, aspect, assets: renderAssets, brand, logoPath, outputPath, metadata: provenance(ad, plan, planVersion) }),
      );
      try {
        this.assertCurrent(ad, v);
      } catch (err) {
        if (outputPath && out.file) await fsp.rm(outputPath, { force: true }); // cancelled while rendering: do not keep the file
        throw err;
      }
      if (ad.renders.some((r) => r.aspect_ratio === aspect)) continue;
      if (out.file) {
        if (!outputPath) throw new AdError("invalid_input", "The renderer wrote a file but no renderDir is configured.");
        this.store.renders.set(renderId, { account_id: ad.account_id, ad_id: ad.id, path: outputPath, bytes: out.file.bytes });
      }
      ad.renders.push({ render_id: renderId, aspect_ratio: aspect, stored: !!out.file, url: out.url, bytes: out.file?.bytes, duration_s: out.file?.duration_s, notes: [...ingestNotes, ...(out.notes ?? [])], renderer_version: out.renderer_version });
    }
    this.settle(p.reservation_id, ad);
    this.transition(ad, ["rendering"], "completed");
  }

  // ---------- finished videos ----------

  /** What clients see for each render: a fresh short-lived link (never a stored one), size, and any notes. */
  renderViews(ad: Ad) {
    return ad.renders.map((r) => {
      const link = r.stored ? this.downloads.sign(ad.account_id, r.render_id) : null;
      return {
        render_id: r.render_id,
        aspect_ratio: r.aspect_ratio,
        url: link?.url ?? r.url ?? null,
        expires_at: link?.expires_at ?? null,
        bytes: r.bytes ?? null,
        duration_s: r.duration_s ?? null,
        notes: r.notes ?? [],
        renderer_version: r.renderer_version ?? null,
        ...(this.opts.exposeLocalPaths && r.stored ? { local_path: this.store.renders.get(r.render_id)?.path } : {}),
      };
    });
  }

  /** A new link for a render, for when an earlier one has expired. */
  downloadUrl(ctx: Ctx, renderId: string): SignedLink & { render_id: string } {
    requireScope(ctx, "ads:read");
    const rec = this.store.renders.get(renderId);
    if (!rec || rec.account_id !== ctx.accountId) throw new AdError("not_found", `No render with id ${renderId}.`);
    return { render_id: renderId, ...this.downloads.sign(ctx.accountId, renderId) };
  }

  /** For the file route. The signature is the authorisation, so this also checks the render belongs to that account. */
  renderFile(renderId: string, accountId: string): { path: string; bytes: number } | null {
    const rec = this.store.renders.get(renderId);
    return rec && rec.account_id === accountId ? { path: rec.path, bytes: rec.bytes } : null;
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

  private requireAd(ctx: Ctx, id: string): Ad {
    const ad = this.store.ads.get(id);
    if (!ad || ad.account_id !== ctx.accountId) throw new AdError("not_found", `No ad with id ${id}.`);
    return ad;
  }

  private requireStatus(ctx: Ctx, id: string, status: JobStatus, tool: string): Ad {
    const ad = this.requireAd(ctx, id);
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

  /** Version-checked state change. Returns the new version. */
  private transition(ad: Ad, from: JobStatus[], to: JobStatus): number {
    if (!from.includes(ad.status)) {
      throw new AdError("conflict", `Ad ${ad.id} is "${ad.status}", expected ${from.join(" or ")}.`);
    }
    ad.status = to;
    return ++ad.version;
  }

  private assertCurrent(ad: Ad, version: number) {
    if (ad.version !== version) throw new Superseded();
  }

  private failAd(ad: Ad, err: unknown) {
    if (TERMINAL.includes(ad.status)) return;
    ad.error = err instanceof Error ? err.message : String(err);
    ad.status = "failed";
    ad.version++;
    this.releaseReservations(ad.id);
    this.store.appendAudit(ad.account_id, "system", "ad.failed", { ad_id: ad.id, error: ad.error });
  }

  private reserve(ctx: Ctx, ad: Ad, estimate: Estimate, maxCredits: number): Reservation {
    if (estimate.credits > maxCredits) {
      throw new AdError("invalid_input", `Estimate is ${estimate.credits} credits, above max_credits ${maxCredits}.`);
    }
    const available = this.store.available(ctx.accountId);
    if (available < estimate.credits) {
      throw new AdError("insufficient_credits", `Needs ${estimate.credits} credits but ${available} are available.`);
    }
    const r: Reservation = { id: randomUUID(), account_id: ctx.accountId, ad_id: ad.id, amount: estimate.credits, status: "held" };
    this.store.reservations.set(r.id, r);
    return r;
  }

  private settle(reservationId: string, ad: Ad) {
    const r = this.store.reservations.get(reservationId);
    if (!r || r.status !== "held") return;
    r.status = "settled";
    this.store.ledger.push({ id: randomUUID(), account_id: r.account_id, ad_id: ad.id, delta: -r.amount, reason: "render" });
  }

  private releaseReservations(adId: string) {
    for (const r of this.store.reservations.values()) if (r.ad_id === adId && r.status === "held") r.status = "released";
  }

  private checkDuration(plan: ScenePlan, target: number) {
    const total = totalDuration(plan);
    if (Math.abs(total - target) > 1) {
      throw new AdError("invalid_input", `Scene durations add up to ${total}s but the ad must be ${target}s (±1s).`);
    }
  }

  /** Same key + same request returns the original ad; same key + different request is a conflict. */
  private idem(ctx: Ctx, tool: string, key: string, args: unknown, run: () => Ad): Ad {
    const k = `${ctx.accountId}:${key}`;
    const hash = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex");
    const prior = this.store.idempotency.get(k);
    if (prior) {
      if (prior.hash !== hash) throw new AdError("conflict", "This idempotency_key was already used for a different request.");
      return this.requireAd(ctx, prior.ad_id);
    }
    const ad = run();
    this.store.idempotency.set(k, { hash, ad_id: ad.id });
    return ad;
  }
}
