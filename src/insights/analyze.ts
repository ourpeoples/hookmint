import { createHash } from "node:crypto";
import { ALPHA, holm, METHOD_VERSION, rateRatio, shrink, twoProportionZ, wilson, type Counts, type Interval } from "./stats.js";

export type LaunchMode = "platform_experiment" | "same_ad_set" | "separate";
export type Metric = "ctr" | "cvr";

/** The smallest amount of data per variant before a metric is allowed to name a winner. Part of method m1. */
export const THRESHOLDS: Record<Metric, { trials: "impressions" | "clicks"; minTrials: number; successes: "clicks" | "conversions"; minSuccesses: number }> = {
  ctr: { trials: "impressions", minTrials: 1000, successes: "clicks", minSuccesses: 20 },
  cvr: { trials: "clicks", minTrials: 100, successes: "conversions", minSuccesses: 10 },
};

export interface Snapshot {
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  currency: string;
  attribution_window: string;
  timezone: string;
}

export interface VariantInput {
  ad_id: string;
  is_base: boolean;
  /** The text of the idea being tested in this variant (its hook, angle, offer, call to action or style). */
  value: string;
  /** One launch mode per live ad this variant is linked to. */
  launch_modes: LaunchMode[];
  /** One row per link per day, already reduced to the latest correction of each. */
  rows: (Snapshot & { link_id: string })[];
}

export interface Totals {
  days: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}
export interface MetricView {
  rate: number | null;
  interval: Interval | null;
  /** Pulled toward the overall rate to limit the winner's curse. Only with three or more variants. */
  shrunk_rate: number | null;
}
export interface VsBase {
  ratio: number;
  interval: Interval;
  p_adjusted: number;
}
export interface VariantReport {
  ad_id: string;
  role: "base" | "variant";
  value: string;
  totals: Totals;
  cost_per_conversion: { value: number | null; note: string };
  ctr: MetricView;
  cvr: MetricView;
  vs_base: { ctr: VsBase | null; cvr: VsBase | null } | null;
}
export interface MetricVerdict {
  status: "winner" | "no_clear_winner" | "insufficient_data";
  winner_ad_id: string | null;
  /** Why there is no verdict, in plain words, for every variant that is short of data. */
  shortfalls: { ad_id: string; need: string }[];
  /** All pairwise comparisons, with Holm-adjusted p-values across the whole family. */
  comparisons: { a: string; b: string; p: number; p_adjusted: number }[];
}
export interface GroupReport {
  method_version: string;
  tested_variable: string;
  alpha: number;
  window: { start: string; end: string; days: number } | null;
  evidence: "causal" | "observational";
  comparable: boolean;
  warnings: string[];
  variants: VariantReport[];
  verdicts: Record<Metric, MetricVerdict>;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (x: number, digits = 6) => Math.round(x * 10 ** digits) / 10 ** digits;
const pct = (x: number) => `${round(x * 100, 2)}%`;

/** Combines a variant's rows by day (it may be live on several platforms) over the days every variant has data for. */
function dailyTotals(rows: VariantInput["rows"], days: Set<string>) {
  const byDay = new Map<string, Snapshot>();
  for (const r of rows) {
    if (!days.has(r.date)) continue;
    const d = byDay.get(r.date);
    if (!d) byDay.set(r.date, { ...r });
    else {
      d.spend += r.spend;
      d.impressions += r.impressions;
      d.clicks += r.clicks;
      d.conversions += r.conversions;
    }
  }
  return [...byDay.values()];
}

const counts = (t: Totals, m: Metric): Counts => (m === "ctr" ? { successes: t.clicks, trials: t.impressions } : { successes: t.conversions, trials: t.clicks });

/**
 * Compares the variants of one group on click-through and conversion rate, honestly:
 * - only days where every variant has data are used, so they ran side by side;
 * - nothing is declared unless every variant has enough data (method m1 thresholds);
 * - every pair is compared and the p-values are corrected for the number of comparisons (Holm);
 * - a winner must beat every other variant, not just the base;
 * - results from variants launched separately are labelled observational, because anything could differ between them.
 */
export function analyzeGroup(testedVariable: string, all: VariantInput[]): GroupReport {
  const warnings: string[] = [];
  // A variant with no results at all has not run yet. It is left out of the comparison (and listed, with zeros) instead of blocking the others.
  const input = all.filter((v) => v.rows.length > 0);
  const idle = all.filter((v) => v.rows.length === 0);
  if (idle.length && input.length) warnings.push(`${idle.length} variant(s) have no results yet and were left out of the comparison.`);
  const modes = all.flatMap((v) => v.launch_modes);
  const evidence: GroupReport["evidence"] = modes.length > 0 && modes.every((m) => m === "platform_experiment" || m === "same_ad_set") ? "causal" : "observational";
  if (evidence === "observational") {
    warnings.push(modes.length ? "At least one variant was launched separately, so audiences, budgets and timing may differ. Differences below are observed, not shown to be caused by the idea." : "No variant is linked to a live ad yet.");
  }

  // Days on which every variant has numbers.
  const dayLists = input.map((v) => new Set(v.rows.map((r) => r.date)));
  const common = dayLists.length ? [...dayLists[0]].filter((d) => dayLists.every((s) => s.has(d))).sort() : [];
  const days = new Set(common);
  const dropped = sum(input.map((v) => v.rows.filter((r) => !days.has(r.date)).length));
  if (dropped > 0 && common.length > 0) warnings.push(`${dropped} daily row(s) were left out because not every variant has data for those days.`);

  // Numbers are only comparable if they were measured the same way.
  const used = input.flatMap((v) => v.rows.filter((r) => days.has(r.date)));
  const currencies = new Set(used.map((r) => r.currency));
  const windows = new Set(used.map((r) => r.attribution_window));
  const zones = new Set(used.map((r) => r.timezone));
  let comparable = true;
  if (currencies.size > 1) { comparable = false; warnings.push(`Results use different currencies (${[...currencies].join(", ")}), so spend cannot be compared.`); }
  if (windows.size > 1) { comparable = false; warnings.push(`Results use different attribution windows (${[...windows].join(", ")}), so conversions are not comparable.`); }
  if (zones.size > 1) warnings.push(`Results use different time zones (${[...zones].join(", ")}); days may not line up exactly.`);

  const variants: VariantReport[] = input.map((v) => {
    const rows = dailyTotals(v.rows, days);
    const totals: Totals = { days: rows.length, spend: round(sum(rows.map((r) => r.spend)), 2), impressions: sum(rows.map((r) => r.impressions)), clicks: sum(rows.map((r) => r.clicks)), conversions: sum(rows.map((r) => r.conversions)) };
    const view = (m: Metric): MetricView => {
      const c = counts(totals, m);
      return c.trials > 0 ? { rate: c.successes / c.trials, interval: wilson(c.successes, c.trials), shrunk_rate: null } : { rate: null, interval: null, shrunk_rate: null };
    };
    return {
      ad_id: v.ad_id,
      role: v.is_base ? "base" : "variant",
      value: v.value,
      totals,
      cost_per_conversion: totals.conversions > 0 ? { value: round(totals.spend / totals.conversions, 2), note: "A point estimate only: it has no interval and is not used to pick a winner." } : { value: null, note: "No conversions yet." },
      ctr: view("ctr"),
      cvr: view("cvr"),
      vs_base: null,
    };
  });

  const verdicts = {} as Record<Metric, MetricVerdict>;
  for (const m of ["ctr", "cvr"] as Metric[]) {
    const t = THRESHOLDS[m];
    const cs = variants.map((v) => counts(v.totals, m));
    const shortfalls: MetricVerdict["shortfalls"] = [];
    variants.forEach((v, i) => {
      const needTrials = Math.max(0, t.minTrials - cs[i].trials);
      const needSuccesses = Math.max(0, t.minSuccesses - cs[i].successes);
      if (needTrials || needSuccesses) {
        const parts = [needTrials ? `${needTrials} more ${t.trials}` : "", needSuccesses ? `${needSuccesses} more ${t.successes}` : ""].filter(Boolean);
        shortfalls.push({ ad_id: v.ad_id, need: parts.join(" and ") });
      }
    });

    // All pairs, one corrected family.
    const pairs: { i: number; j: number; p: number }[] = [];
    for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) pairs.push({ i, j, p: twoProportionZ(cs[i], cs[j]).p });
    const adj = holm(pairs.map((x) => x.p));
    const comparisons = pairs.map((x, k) => ({ a: variants[x.i].ad_id, b: variants[x.j].ad_id, p: round(x.p), p_adjusted: round(adj[k]) }));

    const baseIdx = variants.findIndex((v) => v.role === "base");
    if (baseIdx >= 0) {
      variants.forEach((v, i) => {
        if (i === baseIdx) return;
        const pairIdx = pairs.findIndex((x) => (x.i === baseIdx && x.j === i) || (x.i === i && x.j === baseIdx));
        if (cs[i].trials > 0 && cs[baseIdx].trials > 0) {
          const rr = rateRatio(cs[baseIdx], cs[i]);
          v.vs_base ??= { ctr: null, cvr: null };
          v.vs_base[m] = { ratio: round(rr.ratio), interval: { low: round(rr.interval.low), high: round(rr.interval.high) }, p_adjusted: round(adj[pairIdx]) };
        }
      });
    }

    const shrunk = shrink(cs);
    if (shrunk) variants.forEach((v, i) => { v[m].shrunk_rate = round(shrunk[i]); });

    let status: MetricVerdict["status"];
    let winner: string | null = null;
    if (!comparable || shortfalls.length || variants.length < 2) status = "insufficient_data";
    else {
      const idx = variants.findIndex((_, i) => variants.every((_, j) => {
        if (i === j) return true;
        const k = pairs.findIndex((x) => (x.i === i && x.j === j) || (x.i === j && x.j === i));
        return cs[i].successes / cs[i].trials > cs[j].successes / cs[j].trials && adj[k] < ALPHA;
      }));
      if (idx >= 0) { status = "winner"; winner = variants[idx].ad_id; } else status = "no_clear_winner";
    }
    verdicts[m] = { status, winner_ad_id: winner, shortfalls: comparable ? shortfalls : [{ ad_id: "*", need: "comparable measurements (see warnings)" }], comparisons };
  }

  for (const v of idle) {
    const none: MetricView = { rate: null, interval: null, shrunk_rate: null };
    variants.push({ ad_id: v.ad_id, role: v.is_base ? "base" : "variant", value: v.value, totals: { days: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0 }, cost_per_conversion: { value: null, note: "No results yet." }, ctr: { ...none }, cvr: { ...none }, vs_base: null });
  }
  const window = common.length ? { start: common[0], end: common.at(-1)!, days: common.length } : null;
  if (!window && input.length > 1) warnings.push("The variants have no days in common yet, so they cannot be compared.");
  return { method_version: METHOD_VERSION, tested_variable: testedVariable, alpha: ALPHA, window, evidence, comparable, warnings, variants, verdicts };
}

// ---- insights: plain statements, each tied to the numbers behind it ----

export interface Insight {
  id: string;
  method_version: string;
  group_id: string;
  tested_variable: string;
  metric: Metric;
  evidence: "causal" | "observational";
  /** Only causal, concluded insights may steer future scripts. */
  usable_for_generation: boolean;
  winning_value: string;
  beaten_values: string[];
  /** Winner's rate divided by the next best variant's, with its 95% interval. */
  lift_vs_runner_up: { ratio: number; interval: Interval };
  adjusted_p: number;
  sample_size: { impressions_per_variant_min: number; clicks_per_variant_min: number };
  statement: string;
}

const METRIC_NAME: Record<Metric, string> = { ctr: "click-through rate", cvr: "conversion rate" };

/** Turns a concluded group into statements. Anything without a clear winner produces nothing: no invented patterns. */
export function insightsFrom(groupId: string, report: GroupReport): Insight[] {
  const out: Insight[] = [];
  for (const m of ["ctr", "cvr"] as Metric[]) {
    const verdict = report.verdicts[m];
    if (verdict.status !== "winner" || !verdict.winner_ad_id) continue;
    const winner = report.variants.find((v) => v.ad_id === verdict.winner_ad_id)!;
    const active = report.variants.filter((v) => v.totals.days > 0); // variants that have not run are not "beaten"
    const others = active.filter((v) => v !== winner);
    const runnerUp = [...others].sort((a, b) => (b[m].rate ?? 0) - (a[m].rate ?? 0))[0];
    const wc = counts(winner.totals, m);
    const rc = counts(runnerUp.totals, m);
    const rr = rateRatio(rc, wc);
    const pair = verdict.comparisons.find((c) => (c.a === winner.ad_id && c.b === runnerUp.ad_id) || (c.b === winner.ad_id && c.a === runnerUp.ad_id))!;
    const causal = report.evidence === "causal";
    const lift = round((rr.ratio - 1) * 100, 1);
    const statement =
      `${causal ? "In a controlled test" : "Observed, not controlled"}: for "${report.tested_variable}", "${winner.value}" had a higher ${METRIC_NAME[m]} than "${runnerUp.value}" ` +
      `(${pct(winner[m].rate!)} against ${pct(runnerUp[m].rate!)}, ${lift >= 0 ? "+" : ""}${lift}% relative, 95% interval ${round((rr.interval.low - 1) * 100, 1)}% to ${round((rr.interval.high - 1) * 100, 1)}%; ` +
      `corrected p = ${pair.p_adjusted}). This is one test on one audience: it suggests, and does not prove, that the idea works elsewhere.`;
    out.push({
      id: `ins_${createHash("sha256").update(`${METHOD_VERSION}:${groupId}:${m}`).digest("hex").slice(0, 12)}`,
      method_version: METHOD_VERSION,
      group_id: groupId,
      tested_variable: report.tested_variable,
      metric: m,
      evidence: report.evidence,
      usable_for_generation: causal,
      winning_value: winner.value,
      beaten_values: others.map((o) => o.value),
      lift_vs_runner_up: { ratio: round(rr.ratio), interval: { low: round(rr.interval.low), high: round(rr.interval.high) } },
      adjusted_p: pair.p_adjusted,
      sample_size: { impressions_per_variant_min: Math.min(...active.map((v) => v.totals.impressions)), clicks_per_variant_min: Math.min(...active.map((v) => v.totals.clicks)) },
      statement,
    });
  }
  return out;
}
