import { z } from "zod";

export const PLATFORMS = ["meta", "tiktok", "google", "youtube", "linkedin", "other"] as const;
export const LAUNCH_MODES = ["platform_experiment", "same_ad_set", "separate"] as const;

const MAX_COUNT = 10_000_000_000;
const count = z.number().int().min(0).max(MAX_COUNT);

export const LinkInput = z.object({
  platform: z.enum(PLATFORMS),
  platform_ad_id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/, "use the platform's ad id: letters, digits and - _ . :"),
  launch_mode: z.enum(LAUNCH_MODES),
  aspect_ratio: z.enum(["9:16", "1:1", "16:9"]).optional(),
});

export const DayShape = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-05-31"),
  impressions: count,
  clicks: count,
  conversions: count.default(0),
  spend: z.number().min(0).max(1e9).default(0),
});

export const DayInput = DayShape
  .refine((d) => d.clicks <= d.impressions, { message: "clicks cannot be more than impressions" })
  .refine((d) => d.conversions <= d.impressions, { message: "conversions cannot be more than impressions" });

export const PerformanceInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, "currency is a three-letter code like USD"),
  timezone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_/+-]+$/).default("UTC"),
  /** How the platform counts a conversion, e.g. "7d_click_1d_view". Variants are only compared when this matches. */
  attribution_window: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).default("unspecified"),
  rows: z.array(DayInput).min(1).max(100),
});

export const TestPlanInput = z.object({
  baseline_rate: z.number().gt(0).lt(1),
  relative_lift: z.number().gt(0).max(10),
  variants: z.number().int().min(2).max(11),
  power: z.number().min(0.5).max(0.99).default(0.8),
  expected_daily_impressions_per_variant: z.number().int().min(1).max(1e9).optional(),
});

export const isRealDate = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
