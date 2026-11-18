import assert from "node:assert/strict";
import { ALPHA, holm, normalCdf, normalQuantile, rateRatio, sampleSizePerVariant, shrink, twoProportionZ, twoSidedP, wilson } from "../src/insights/stats.js";

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};
const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// A small seeded generator, so a simulation gives the same answer every run.
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const binomial = (rand: () => number, n: number, p: number) => {
  // Normal approximation is poor for small n*p, so draw exactly in blocks.
  let x = 0;
  for (let i = 0; i < n; i++) if (rand() < p) x++;
  return x;
};

await test("normal distribution: matches published values to many digits, and the quantile inverts the cdf", () => {
  close(normalCdf(0), 0.5, 1e-15, "cdf(0)");
  close(normalCdf(1.959963984540054), 0.975, 1e-12, "cdf(1.96)");
  close(normalCdf(-1), 0.15865525393145707, 1e-12, "cdf(-1)");
  close(normalCdf(3), 0.9986501019683699, 1e-12, "cdf(3)");
  close(normalCdf(-6), 9.865876450376946e-10, 1e-15, "far tail");
  close(twoSidedP(1.959963984540054), 0.05, 1e-12, "p at 1.96");
  close(twoSidedP(2.5758293035489), 0.01, 1e-12, "p at 2.576");
  close(twoSidedP(0), 1, 1e-15, "p at 0");
  close(normalQuantile(0.975), 1.959963984540054, 1e-10, "q(0.975)");
  close(normalQuantile(0.8), 0.8416212335729143, 1e-10, "q(0.8)");
  close(normalQuantile(0.001), -3.090232306167813, 1e-9, "q(0.001)");
  for (const p of [1e-6, 0.01, 0.2, 0.5, 0.77, 0.999]) close(normalCdf(normalQuantile(p)), p, 1e-12, `round trip ${p}`);
  assert.throws(() => normalQuantile(0), RangeError);
  assert.throws(() => normalQuantile(1), RangeError);
});

await test("wilson interval: known values, sane at zero and small counts, never outside 0 to 1", () => {
  const w = wilson(10, 100);
  close(w.low, 0.0552, 5e-4, "10/100 low");
  close(w.high, 0.1744, 5e-4, "10/100 high");
  const zero = wilson(0, 50);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0.05 && zero.high < 0.09, `0/50 high ${zero.high}`);
  const all = wilson(50, 50);
  assert.equal(all.high, 1);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  for (const [s, t] of [[1, 3], [3, 3], [0, 1], [500, 1000], [1, 1_000_000]]) {
    const i = wilson(s, t);
    assert.ok(i.low >= 0 && i.high <= 1 && i.low <= s / t && s / t <= i.high, `${s}/${t}`);
  }
});

await test("wilson interval: covers the true rate about 95% of the time in simulation", () => {
  const rand = rng(7);
  for (const [p, nTrials] of [[0.02, 1500], [0.1, 400], [0.5, 100]] as const) {
    let covered = 0;
    const runs = 2000;
    for (let i = 0; i < runs; i++) {
      const w = wilson(binomial(rand, nTrials, p), nTrials);
      if (w.low <= p && p <= w.high) covered++;
    }
    const rate = covered / runs;
    assert.ok(rate > 0.93 && rate < 0.97, `coverage ${rate} at p=${p}, n=${nTrials}`);
  }
});

await test("two-proportion test: matches a hand calculation, is symmetric, and finds nothing when rates match", () => {
  const r = twoProportionZ({ successes: 100, trials: 1000 }, { successes: 130, trials: 1000 });
  close(r.z, 2.1027, 1e-3, "z"); // pooled p = .115, se = sqrt(.115*.885*.002) = .014267, difference .03
  close(r.p, 0.0355, 5e-4, "p");
  const flipped = twoProportionZ({ successes: 130, trials: 1000 }, { successes: 100, trials: 1000 });
  close(flipped.z, -r.z, 1e-12, "sign flips");
  close(flipped.p, r.p, 1e-12, "same p");
  assert.equal(twoProportionZ({ successes: 50, trials: 500 }, { successes: 100, trials: 1000 }).p, 1);
  assert.deepEqual(twoProportionZ({ successes: 0, trials: 100 }, { successes: 0, trials: 100 }), { z: 0, p: 1 });
  assert.deepEqual(twoProportionZ({ successes: 0, trials: 0 }, { successes: 5, trials: 100 }), { z: 0, p: 1 });
});

await test("rate ratio: the interval contains the ratio, excludes 1 exactly when the test would, and survives zero counts", () => {
  const r = rateRatio({ successes: 100, trials: 1000 }, { successes: 130, trials: 1000 });
  close(r.ratio, 1.3, 1e-12, "ratio");
  assert.ok(r.interval.low > 1 && r.interval.low < 1.3 && r.interval.high > 1.3, JSON.stringify(r));
  const noDiff = rateRatio({ successes: 100, trials: 1000 }, { successes: 102, trials: 1000 });
  assert.ok(noDiff.interval.low < 1 && noDiff.interval.high > 1);
  const zero = rateRatio({ successes: 0, trials: 500 }, { successes: 12, trials: 500 });
  assert.ok(Number.isFinite(zero.ratio) && Number.isFinite(zero.interval.low) && Number.isFinite(zero.interval.high));
  assert.ok(zero.interval.low > 1, "twelve against none is clearly more");
});

await test("holm: matches the textbook example, never lowers a p-value, keeps order, and caps at 1", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((x) => +x.toFixed(10)), [0.03, 0.06, 0.06]);
  assert.deepEqual(holm([0.5]), [0.5]);
  assert.deepEqual(holm([]), []);
  const p = [0.2, 0.001, 0.04, 0.9, 0.0004];
  const adj = holm(p);
  adj.forEach((a, i) => assert.ok(a >= p[i] && a <= 1, `adjusted ${a} vs raw ${p[i]}`));
  assert.ok(adj[1] <= adj[2] && adj[4] <= adj[1], "adjusted values keep the order of the raw ones");
  assert.deepEqual(holm([0.6, 0.7]), [1, 1]);
});

await test("false wins: with variants that are all the same, 'significant' appears no more often than the stated 5%, even with many variants", () => {
  const rand = rng(11);
  for (const k of [2, 4, 6]) {
    let falseWins = 0;
    const runs = 1500;
    for (let r = 0; r < runs; r++) {
      const v = Array.from({ length: k }, () => ({ successes: binomial(rand, 1200, 0.04), trials: 1200 }));
      const pairs: number[] = [];
      for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) pairs.push(twoProportionZ(v[i], v[j]).p);
      if (holm(pairs).some((x) => x < ALPHA)) falseWins++;
    }
    const rate = falseWins / runs;
    assert.ok(rate <= 0.065, `k=${k}: ${(rate * 100).toFixed(1)}% of identical groups produced a "significant" pair`);
  }
  // Without the correction the same data would produce far more false wins, which is the point of having it.
  const rand2 = rng(12);
  let uncorrected = 0;
  for (let r = 0; r < 1500; r++) {
    const v = Array.from({ length: 6 }, () => ({ successes: binomial(rand2, 1200, 0.04), trials: 1200 }));
    let any = false;
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (twoProportionZ(v[i], v[j]).p < ALPHA) any = true;
    if (any) uncorrected++;
  }
  assert.ok(uncorrected / 1500 > 0.2, `uncorrected: ${(uncorrected / 100 / 15).toFixed(1)}% (expected well above 5%)`);
});

await test("power: a real lift of the size the planner was asked about is found about as often as promised", () => {
  const baseline = 0.03;
  const lift = 0.3;
  const per = sampleSizePerVariant({ baselineRate: baseline, relativeLift: lift, variants: 2 });
  const rand = rng(21);
  let found = 0;
  const runs = 600;
  for (let r = 0; r < runs; r++) {
    const a = { successes: binomial(rand, per, baseline), trials: per };
    const b = { successes: binomial(rand, per, baseline * (1 + lift)), trials: per };
    if (twoProportionZ(a, b).p < ALPHA) found++;
  }
  const power = found / runs;
  assert.ok(power > 0.74 && power < 0.87, `power ${power} with ${per} per variant (promised 0.80)`);
});

await test("sample size: known values, grows with more variants and smaller lifts, and refuses nonsense", () => {
  // 5% baseline, +20% relative, 80% power, 5% two-sided, two variants: about 8,100 per variant
  const n = sampleSizePerVariant({ baselineRate: 0.05, relativeLift: 0.2, variants: 2 });
  assert.ok(n > 8000 && n < 8400, `${n}`);
  assert.ok(sampleSizePerVariant({ baselineRate: 0.05, relativeLift: 0.2, variants: 4 }) > n, "more variants need more");
  assert.ok(sampleSizePerVariant({ baselineRate: 0.05, relativeLift: 0.1, variants: 2 }) > 3 * n, "half the lift needs about four times the sample");
  assert.ok(sampleSizePerVariant({ baselineRate: 0.05, relativeLift: 0.2, variants: 2, power: 0.9 }) > n);
  assert.throws(() => sampleSizePerVariant({ baselineRate: 0, relativeLift: 0.2, variants: 2 }), RangeError);
  assert.throws(() => sampleSizePerVariant({ baselineRate: 1, relativeLift: 0.2, variants: 2 }), RangeError);
  assert.throws(() => sampleSizePerVariant({ baselineRate: 0.05, relativeLift: 0, variants: 2 }), RangeError);
  assert.throws(() => sampleSizePerVariant({ baselineRate: 0.6, relativeLift: 0.9, variants: 2 }), RangeError);
});

await test("shrinkage: needs three variants, pulls the extremes in, and fully so when the differences look like chance", () => {
  assert.equal(shrink([{ successes: 5, trials: 100 }, { successes: 9, trials: 100 }]), null);
  const spread = shrink([{ successes: 20, trials: 1000 }, { successes: 40, trials: 1000 }, { successes: 60, trials: 1000 }])!;
  assert.ok(spread[2] < 0.06 && spread[2] > 0.04, "the best is pulled toward the middle but stays the best");
  assert.ok(spread[0] > 0.02 && spread[0] < 0.04);
  assert.ok(spread[0] < spread[1] && spread[1] < spread[2], "order is kept");
  const chance = shrink([{ successes: 40, trials: 1000 }, { successes: 41, trials: 1000 }, { successes: 39, trials: 1000 }])!;
  chance.forEach((x) => close(x, 0.04, 1e-9, "all shrink to the overall rate"));
  // Small noisy variants are pulled in harder than large precise ones with the same raw rate.
  const mixed = shrink([{ successes: 10, trials: 100 }, { successes: 100, trials: 1000 }, { successes: 50, trials: 1000 }, { successes: 30, trials: 1000 }])!;
  assert.ok(Math.abs(mixed[0] - 0.1) > Math.abs(mixed[1] - 0.1) - 1e-9, "the small sample moved at least as far from its raw rate as the large one");
  assert.equal(shrink([{ successes: 0, trials: 0 }, { successes: 0, trials: 0 }, { successes: 0, trials: 0 }]), null);
});

await test("winner's curse: reporting the raw best of many identical variants overstates it, and shrinkage removes most of that", () => {
  const rand = rng(33);
  let rawBias = 0;
  let shrunkBias = 0;
  const runs = 400;
  for (let r = 0; r < runs; r++) {
    const v = Array.from({ length: 6 }, () => ({ successes: binomial(rand, 800, 0.04), trials: 800 }));
    const s = shrink(v)!;
    let best = 0;
    v.forEach((x, i) => { if (x.successes / x.trials > v[best].successes / v[best].trials) best = i; });
    rawBias += v[best].successes / v[best].trials - 0.04;
    shrunkBias += s[best] - 0.04;
  }
  rawBias /= runs;
  shrunkBias /= runs;
  assert.ok(rawBias > 0.006, `raw best overstates by ${(rawBias * 100).toFixed(2)} points`);
  assert.ok(Math.abs(shrunkBias) < rawBias / 2, `shrunk bias ${(shrunkBias * 100).toFixed(2)} points is less than half of ${(rawBias * 100).toFixed(2)}`);
});

console.log(`stats: ${n} tests passed`);
process.exit(0);
