import { ALPHA, holm, rateRatio, twoProportionZ, wilson, type Counts, type Interval } from "./stats.js";
import { THRESHOLDS, type Metric, type Snapshot } from "./analyze.js";

/**
 * Patterns across ALL of a brand's ads, grouped by one dimension: the kind of hook (hook_type) or the platform the ad ran on.
 * These are observational. The ads differ in wording, footage, audience and timing as well as in the dimension, so a gap between
 * groups is a lead to test, never a result, and nothing here may steer generation (only a controlled test can). It has its own
 * method version, separate from the controlled-test method, so changing one never silently changes the other.
 */
export const BREAKDOWN_METHOD_VERSION = "b1";
/** A group of one ad is just that ad. Rates are shown for it, but it is never compared. */
export const BREAKDOWN_MIN_ADS = 2;

export type BreakdownDimension = "hook_type" | "platform";

export interface BreakdownLink {
  ad_id: string;
  /** The label on the ad's current plan, or null when it has none (an older ad, or a rewritten hook). */
  hook_type: string | null;
  link_id: string;
  /** The platform the ad actually ran on, from the link (not the platform it was written for). */
  platform: string;
  /** One row per day, already reduced to the latest correction of each. */
  rows: Snapshot[];
}

export interface BreakdownRow {
  value: string;
  ads: number;
  days: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: { rate: number | null; interval: Interval | null };
  cvr: { rate: number | null; interval: Interval | null };
  cost_per_conversion: number | null;
  /** Why this group is not compared yet, in plain words. Null when it has enough ads and data for at least one metric. */
  shortfall: string | null;
}

export interface BreakdownLead {
  metric: Metric;
  leading_value: string;
  beaten_values: string[];
  lift_vs_runner_up: { ratio: number; interval: Interval };
  adjusted_p: number;
  evidence: "observational";
  /** Observational leads never steer generation. */
  usable_for_generation: false;
  /** A controlled test that would settle it, when one exists. */
  suggested_test: string | null;
  statement: string;
}

export interface Breakdown {
  method_version: string;
  dimension: BreakdownDimension;
  /** Set when the comparison is made inside one platform, so a hook type is not credited with what the platform did. */
  within: { platform: string } | null;
  evidence: "observational";
  comparable: boolean;
  measurement: { attribution_window: string | null; timezone: string | null };
  rows: BreakdownRow[];
  leads: BreakdownLead[];
  /** Ads that ran but carry no hook type, so they are not in a hook_type breakdown. */
  unlabelled_ads: number;
  warnings: string[];
}

const LABEL: Record<BreakdownDimension, string> = { hook_type: "hook type", platform: "platform" };
const METRIC_NAME: Record<Metric, string> = { ctr: "click-through rate", cvr: "conversion rate" };
const round = (x: number, digits = 6) => Math.round(x * 10 ** digits) / 10 ** digits;
const pct = (x: number) => `${round(x * 100, 2)}%`;
const counts = (r: { impressions: number; clicks: number; conversions: number }, m: Metric): Counts => (m === "ctr" ? { successes: r.clicks, trials: r.impressions } : { successes: r.conversions, trials: r.clicks });
const only = (xs: Iterable<string>) => {
  const s = new Set(xs);
  return s.size === 1 ? [...s][0] : null;
};

interface Acc {
  value: string;
  ads: Set<string>;
  dates: Set<string>;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currencies: Set<string>;
}

function one(dimension: BreakdownDimension, within: string | null, links: BreakdownLink[]): Breakdown | null {
  const use = within ? links.filter((l) => l.platform === within) : links;
  const groups = new Map<string, Acc>();
  const unlabelled = new Set<string>();
  const windows = new Set<string>();
  const zones = new Set<string>();
  for (const l of use) {
    if (!l.rows.length) continue;
    const value = dimension === "platform" ? l.platform : l.hook_type;
    if (!value) {
      unlabelled.add(l.ad_id);
      continue;
    }
    const g = groups.get(value) ?? { value, ads: new Set(), dates: new Set(), spend: 0, impressions: 0, clicks: 0, conversions: 0, currencies: new Set() };
    g.ads.add(l.ad_id);
    for (const r of l.rows) {
      g.dates.add(r.date);
      g.spend += r.spend;
      g.impressions += r.impressions;
      g.clicks += r.clicks;
      g.conversions += r.conversions;
      g.currencies.add(r.currency);
      windows.add(r.attribution_window);
      zones.add(r.timezone);
    }
    groups.set(value, g);
  }
  if (groups.size < 2) return null; // nothing to compare

  const warnings: string[] = [];
  const comparable = windows.size <= 1 && zones.size <= 1;
  if (!comparable) warnings.push("These ads were measured with different attribution windows or time zones, so their rates are shown but not compared.");
  warnings.push("These ads differ in more than this one thing (wording, footage, audience, timing), so a gap is a lead to test, not a result.");

  const rows: BreakdownRow[] = [...groups.values()]
    .map((g): BreakdownRow => {
      const ctr = g.impressions > 0 ? g.clicks / g.impressions : null;
      const cvr = g.clicks > 0 ? g.conversions / g.clicks : null;
      const enough = (m: Metric) => {
        const t = THRESHOLDS[m];
        const c = counts(g as never, m);
        return c.trials >= t.minTrials && c.successes >= t.minSuccesses;
      };
      let shortfall: string | null = null;
      if (g.ads.size < BREAKDOWN_MIN_ADS) shortfall = `Only ${g.ads.size} ad; at least ${BREAKDOWN_MIN_ADS} are needed before this group is compared.`;
      else if (!enough("ctr") && !enough("cvr")) shortfall = `Not enough data yet: ${THRESHOLDS.ctr.minTrials} impressions and ${THRESHOLDS.ctr.minSuccesses} clicks are needed for click-through rate.`;
      return {
        value: g.value,
        ads: g.ads.size,
        days: g.dates.size,
        spend: round(g.spend, 2),
        impressions: g.impressions,
        clicks: g.clicks,
        conversions: g.conversions,
        ctr: { rate: ctr === null ? null : round(ctr), interval: g.impressions > 0 ? roundInterval(wilson(g.clicks, g.impressions)) : null },
        cvr: { rate: cvr === null ? null : round(cvr), interval: g.clicks > 0 ? roundInterval(wilson(g.conversions, g.clicks)) : null },
        cost_per_conversion: g.conversions > 0 && g.currencies.size === 1 ? round(g.spend / g.conversions, 2) : null,
        shortfall,
      };
    })
    .sort((a, b) => b.impressions - a.impressions || a.value.localeCompare(b.value));

  const leads: BreakdownLead[] = [];
  if (comparable) {
    for (const m of ["ctr", "cvr"] as Metric[]) {
      const t = THRESHOLDS[m];
      const ready = rows.filter((r) => r.ads >= BREAKDOWN_MIN_ADS && counts(r, m).trials >= t.minTrials && counts(r, m).successes >= t.minSuccesses);
      if (ready.length < 2) continue;
      const rate = (r: BreakdownRow) => counts(r, m).successes / counts(r, m).trials;
      const sorted = [...ready].sort((a, b) => rate(b) - rate(a));
      const best = sorted[0];
      const others = sorted.slice(1);
      // The leader has to beat every other group, with the chance of a false lead controlled across all those comparisons.
      const raw = others.map((o) => twoProportionZ(counts(o, m), counts(best, m)).p);
      const adj = holm(raw);
      if (!adj.every((p) => p < ALPHA)) continue;
      const runnerUp = others[0];
      const rr = rateRatio(counts(runnerUp, m), counts(best, m));
      const lift = round((rr.ratio - 1) * 100, 1);
      const where = within ? ` on ${within}` : "";
      leads.push({
        metric: m,
        leading_value: best.value,
        beaten_values: others.map((o) => o.value),
        lift_vs_runner_up: { ratio: round(rr.ratio), interval: roundInterval(rr.interval) },
        adjusted_p: round(adj[0]),
        evidence: "observational",
        usable_for_generation: false,
        suggested_test: dimension === "hook_type" ? `Test it: run create_variants with tested_variable "hook_type" on one of your ads${where}.` : null,
        statement:
          `Observed, not controlled: across your ads${where}, ${LABEL[dimension]} "${best.value}" had a higher ${METRIC_NAME[m]} than "${runnerUp.value}" ` +
          `(${pct(rate(best))} against ${pct(rate(runnerUp))}, ${lift >= 0 ? "+" : ""}${lift}% relative, 95% interval ${round((rr.interval.low - 1) * 100, 1)}% to ${round((rr.interval.high - 1) * 100, 1)}%; corrected p = ${round(Math.max(...adj), 4)}). ` +
          `These ads also differ in wording, footage and audience, so this is a lead to test, not a result.`,
      });
    }
  }

  return {
    method_version: BREAKDOWN_METHOD_VERSION,
    dimension,
    within: within ? { platform: within } : null,
    evidence: "observational",
    comparable,
    measurement: { attribution_window: only(windows), timezone: only(zones) },
    rows,
    leads,
    unlabelled_ads: unlabelled.size,
    warnings,
  };
}

const roundInterval = (i: Interval): Interval => ({ low: round(i.low), high: round(i.high) });

/**
 * Every breakdown worth showing for a brand's ad links: platforms, hook types overall, and hook types inside each platform (so a hook
 * type is compared with others on the same platform, not credited with what the platform did). A breakdown with fewer than two groups
 * to compare is left out.
 */
export function computeBreakdowns(links: BreakdownLink[]): Breakdown[] {
  const out: Breakdown[] = [];
  const add = (b: Breakdown | null) => b && out.push(b);
  add(one("platform", null, links));
  add(one("hook_type", null, links));
  const platforms = [...new Set(links.filter((l) => l.rows.length).map((l) => l.platform))].sort();
  if (platforms.length > 1) for (const p of platforms) add(one("hook_type", p, links));
  return out;
}
