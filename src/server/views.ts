import { summarize } from "../brand/check.js";
import { RESULT_SCHEMA_VERSION } from "../core/schemas.js";
import type { Ad, AdService } from "../core/service.js";
import type { Ctx } from "../core/context.js";

/** Every result carries schema_version and warnings[] so clients can detect changes and deprecations. */
export function envelope<T extends object>(data: T, warnings: string[] = []) {
  return { schema_version: RESULT_SCHEMA_VERSION, warnings, ...data };
}

export function adView(service: AdService, ctx: Ctx, ad: Ad) {
  return envelope({
    job_id: ad.id,
    status: ad.status,
    version: ad.version,
    progress_pct: service.progress(ad),
    plan: ad.plans.at(-1) ?? null,
    plan_version: ad.plans.length,
    variant_of: ad.variant_of ?? null,
    variant_group_id: ad.plans.at(-1)?.variant_group_id ?? null,
    previews: Object.entries(ad.assets).map(([scene_id, a]) => ({ scene_id, ...a })),
    renders: ad.renders,
    check: (() => {
      const { findings, rule_set_version } = service.findingsFor(ad);
      return { rule_set_version, ...summarize(findings), findings };
    })(),
    balance: service.getBalance(ctx),
    error: ad.error ?? null,
  });
}
