import { z } from "zod";

/**
 * What the structured results of a few tools look like, so a client can render them without parsing text. Objects are
 * loose on purpose: a field added later must not break a client built against this version. Each result still also
 * comes as the same JSON in the text block, for clients that only read text.
 */
const money = z.object({ available: z.number(), held: z.number() });
const base = { schema_version: z.number(), warnings: z.array(z.string()) };
const interval = z.looseObject({ low: z.number(), high: z.number() });

export const AdStatusOutput = {
  ...base,
  job_id: z.string(),
  status: z.enum(["scripting", "awaiting_approval", "generating", "rendering", "completed", "failed", "cancelled"]),
  version: z.number(),
  progress_pct: z.number(),
  plan: z.looseObject({ hook: z.string(), angle: z.string(), scenes: z.array(z.looseObject({ id: z.string() })) }).nullable(),
  plan_version: z.number(),
  variant_of: z.string().nullable(),
  variant_group_id: z.string().nullable(),
  previews: z.array(z.looseObject({ scene_id: z.string(), visual_url: z.string().nullable(), voice_url: z.string().nullable() })),
  renders: z.array(z.looseObject({ render_id: z.string(), aspect_ratio: z.string(), url: z.string().nullable(), expires_at: z.string().nullable(), notes: z.array(z.string()) })),
  check: z.looseObject({ semantic_status: z.string(), findings: z.array(z.looseObject({ rule_id: z.string(), severity: z.string() })) }),
  balance: money,
  error: z.string().nullable(),
};

export const EstimateOutput = {
  ...base,
  credits: z.number(),
  breakdown: z.looseObject({ visuals: z.number(), voice: z.number(), render: z.number() }),
  catalog_version: z.string(),
  balance: money,
};

export const InsightsOutput = {
  ...base,
  brand_kit_id: z.string(),
  method_version: z.string(),
  status: z.enum(["ok", "insufficient_data"]),
  groups_tested: z.number(),
  groups_with_a_clear_winner: z.number(),
  insights: z.array(
    z.looseObject({
      id: z.string(),
      tested_variable: z.string(),
      metric: z.enum(["ctr", "cvr"]),
      evidence: z.enum(["causal", "observational"]),
      usable_for_generation: z.boolean(),
      winning_value: z.string(),
      beaten_values: z.array(z.string()),
      lift_vs_runner_up: z.looseObject({ ratio: z.number(), interval }),
      adjusted_p: z.number(),
      sample_size: z.looseObject({ impressions_per_variant_min: z.number(), clicks_per_variant_min: z.number() }),
      metric_definition: z.looseObject({ metric: z.string(), formula: z.string() }),
      statement: z.string(),
    }),
  ),
  message: z.string(),
  breakdown_method_version: z.string(),
  breakdown_message: z.string(),
  breakdowns: z.array(
    z.looseObject({
      dimension: z.enum(["hook_type", "platform"]),
      within: z.looseObject({ platform: z.string() }).nullable(),
      evidence: z.literal("observational"),
      comparable: z.boolean(),
      unlabelled_ads: z.number(),
      warnings: z.array(z.string()),
      rows: z.array(z.looseObject({ value: z.string(), ads: z.number(), impressions: z.number(), clicks: z.number(), conversions: z.number(), shortfall: z.string().nullable() })),
      leads: z.array(z.looseObject({ metric: z.enum(["ctr", "cvr"]), leading_value: z.string(), beaten_values: z.array(z.string()), usable_for_generation: z.literal(false), adjusted_p: z.number(), statement: z.string() })),
    }),
  ),
};
