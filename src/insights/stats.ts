/**
 * The statistics behind variant results. Everything here is a pure function with no I/O, so it is tested against
 * known values and by simulation. Methods are named and numbered (METHOD_VERSION): change a formula and the number
 * changes, so an old insight is never silently recomputed under different rules.
 */
export const METHOD_VERSION = "m1";
export const ALPHA = 0.05;
const Z95 = 1.959963984540054;

// ---- the normal distribution ----

/** Complementary error function, accurate to about 1e-15 (W. J. Cody's rational approximations, via the standard split). */
function erfc(x: number): number {
  // Numerical Recipes erfc Chebyshev fit is ~1.2e-7; use a series/continued-fraction split for full double precision.
  const ax = Math.abs(x);
  let r: number;
  if (ax < 2.5) {
    // Taylor series of erf around 0 converges fast here.
    let term = ax;
    let sum = ax;
    for (let n = 1; n < 200; n++) {
      term *= (-ax * ax) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    r = 1 - (2 / Math.sqrt(Math.PI)) * sum;
  } else {
    // Continued fraction for erfc (Lentz), good for larger arguments.
    let f = 0;
    for (let k = 60; k >= 1; k--) f = k / 2 / (ax + f);
    r = Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * (ax + f));
  }
  return x >= 0 ? r : 2 - r;
}

/** Standard normal cumulative distribution. */
export const normalCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);

/** Two-sided p-value for a z statistic. */
export const twoSidedP = (z: number) => Math.min(1, erfc(Math.abs(z) / Math.SQRT2));

/** Inverse standard normal (Acklam's algorithm refined by one Halley step), accurate to about 1e-12. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be between 0 and 1");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// ---- rates and intervals ----

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for a rate. Behaves at 0 and at small counts, unlike the textbook normal interval. */
export function wilson(successes: number, trials: number, z = Z95): Interval {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  // At the edges the exact bound is 0 or 1; floating point would leave a speck like 7e-18.
  return { low: successes === 0 ? 0 : Math.max(0, centre - half), high: successes === trials ? 1 : Math.min(1, centre + half) };
}

export interface Counts {
  successes: number;
  trials: number;
}

/** Two-sided test that two rates differ, with a pooled standard error. Returns the z statistic and p-value. */
export function twoProportionZ(a: Counts, b: Counts): { z: number; p: number } {
  if (a.trials <= 0 || b.trials <= 0) return { z: 0, p: 1 };
  const pooled = (a.successes + b.successes) / (a.trials + b.trials);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.trials + 1 / b.trials));
  if (se === 0) return { z: 0, p: 1 }; // both rates are 0 or both are 1: nothing to tell apart
  const z = (b.successes / b.trials - a.successes / a.trials) / se;
  return { z, p: twoSidedP(z) };
}

/**
 * How much bigger (or smaller) b's rate is than a's, as a ratio, with an interval (Katz log method).
 * A count of zero would make the interval undefined, so 0.5 is added to the counts in that case (Haldane-Anscombe).
 */
export function rateRatio(a: Counts, b: Counts, z = Z95): { ratio: number; interval: Interval } {
  const fix = a.successes === 0 || b.successes === 0;
  const xa = a.successes + (fix ? 0.5 : 0);
  const xb = b.successes + (fix ? 0.5 : 0);
  const na = a.trials + (fix ? 0.5 : 0);
  const nb = b.trials + (fix ? 0.5 : 0);
  const ratio = xb / nb / (xa / na);
  const se = Math.sqrt(1 / xb - 1 / nb + 1 / xa - 1 / na);
  return { ratio, interval: { low: Math.exp(Math.log(ratio) - z * se), high: Math.exp(Math.log(ratio) + z * se) } };
}

// ---- many comparisons ----

/** Holm-Bonferroni adjusted p-values: controls the chance of any false win across all the comparisons made. Returned in input order. */
export function holm(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

// ---- shrinkage for the best of many ----

/**
 * Pulls each variant's rate toward the overall rate in proportion to how noisy it is, so the top of a group of similar
 * variants is not reported at face value (the winner's curse). The spread of true differences is estimated from the
 * variants themselves (method of moments); if they look no more different than chance, all shrink fully to the overall rate.
 * Needs at least three variants to estimate that spread; with fewer it returns null.
 */
export function shrink(variants: Counts[]): number[] | null {
  if (variants.length < 3) return null;
  const totalS = variants.reduce((n, v) => n + v.successes, 0);
  const totalN = variants.reduce((n, v) => n + v.trials, 0);
  if (totalN <= 0) return null;
  const overall = totalS / totalN;
  const rates = variants.map((v) => v.successes / v.trials);
  const noise = variants.map((v) => (overall * (1 - overall)) / v.trials);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const spread = rates.reduce((a, r) => a + (r - mean) ** 2, 0) / (rates.length - 1);
  const tau2 = Math.max(0, spread - noise.reduce((a, b) => a + b, 0) / noise.length);
  return rates.map((r, i) => {
    const keep = tau2 / (tau2 + noise[i]); // how much of this variant's own difference is believed
    return overall + keep * (r - overall);
  });
}

// ---- planning a test before launch ----

/**
 * Impressions (or other trials) needed per variant to notice a relative change in a rate: two-sided, with the significance
 * level split across all pairwise comparisons (Bonferroni, which is deliberately cautious), at the stated power.
 */
export function sampleSizePerVariant(opts: { baselineRate: number; relativeLift: number; variants: number; power?: number; alpha?: number }): number {
  const { baselineRate: p1, relativeLift, variants } = opts;
  if (!(p1 > 0 && p1 < 1)) throw new RangeError("baselineRate must be between 0 and 1");
  if (!(relativeLift > 0)) throw new RangeError("relativeLift must be greater than 0");
  const p2 = p1 * (1 + relativeLift);
  if (p2 >= 1) throw new RangeError("that lift would push the rate to 100% or beyond");
  const comparisons = Math.max(1, (variants * (variants - 1)) / 2);
  const zA = normalQuantile(1 - (opts.alpha ?? ALPHA) / comparisons / 2);
  const zB = normalQuantile(opts.power ?? 0.8);
  const pbar = (p1 + p2) / 2;
  const n = (zA * Math.sqrt(2 * pbar * (1 - pbar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}
