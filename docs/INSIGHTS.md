# Results and insights

Hookmint can tell you which of your ideas worked, and says so plainly when it cannot. You launch ads on the ad platform,
copy the daily numbers back (or script it), and Hookmint compares the variants of a test.

## The workflow

1. **Plan** (optional, free): `plan_test` says how many impressions each variant needs to notice a difference of a given
   size. A test that is too small will mostly say "no clear winner", and it is better to know before spending.
2. **Make variants:** `create_variants` makes versions that differ in exactly one thing (hook, angle, offer, call to
   action or visual style). The tool proves they differ only in that one thing.
3. **Launch** them on the platform, side by side. Use the platform's own split test (`platform_experiment`) or put the
   variants in one ad set (`same_ad_set`). Both support a fair comparison. Variants in different ad sets or with
   different budgets (`separate`) are labelled observational, because audience and timing may differ.
4. **Link:** `link_ad` tells Hookmint which live ad each finished ad is, and how it was launched.
5. **Record:** `record_performance` takes daily impressions, clicks, conversions and spend (up to 100 days a call).
   Correct a day by sending it again: the old row stays and the newest is used. Set `attribution_window` to how the
   platform counts conversions; variants measured differently are not compared.
6. **Read:** `get_performance` shows each variant's rates with 95% intervals, the lift over the base, and a verdict.
   `get_insights` turns concluded tests into plain statements for a brand.

## What a verdict means (method `m1`)

- A **winner** must beat *every other* variant, after correcting for the number of comparisons made (Holm), at 5%.
  With many variants the bar rises, so a gap that looks significant pair by pair may not count.
- Nothing is declared until every variant has enough data: for click-through rate, at least 1,000 impressions and 20
  clicks each; for conversion rate (conversions per click), at least 100 clicks and 10 conversions each. Below that the
  answer is `insufficient_data` and says how much more each variant needs.
- Only days where **every** variant has numbers are compared, so the variants ran side by side. A variant with no
  results yet is left out and listed.
- With three or more variants a shrunk rate is also shown, which pulls the best-looking one back toward the average so
  you are not misled by the winner's curse.
- Cost per conversion is shown as a point estimate only. It has no interval and never picks a winner.
- Every insight is labelled **causal** (a fair comparison) or **observational**. Only causal insights are used to
  steer generation.

The formulas are tested against published values and by simulation: identical variants produce a "winner" no more often
than the stated 5%, a real 30% lift is found about as often as the planner promises, and shrinkage removes most of the
winner's curse. If a formula changes, the method version changes (`m1` to `m2`), so an old insight is never silently
recomputed under new rules.

## Patterns across all ads (method `b1`)

`get_insights` also returns `breakdowns`: how a brand's ads did when grouped by **platform** (where each ad actually ran, from its link) and by
**hook type**, and hook type again **inside each platform**, so a kind of hook is compared with others on the same platform and not credited with
what the platform did. This is a separate method from the controlled tests (`m1`), with its own version (`b1`), so changing one never silently
changes the other.

What it is, and is not:
- **Observational only.** The ads differ in wording, footage, audience and timing as well as in the dimension, so a gap is a lead to test. Every
  lead says so, carries `evidence: "observational"` and `usable_for_generation: false`, and never reaches a script prompt. Only a concluded,
  controlled test (`create_variants`, launched side by side) can steer generation.
- **A lead needs a clear leader.** A group must have at least two ads and enough data (the same thresholds as `m1`), and the leader must beat
  *every* other ready group, with p-values corrected across those comparisons (Holm). Anything less shows the rates and the shortfall, no lead.
- **Comparable measurement.** Mixed attribution windows or time zones show the rates but give no lead. Ads with no hook type (older ads, or a
  `hook`/`angle` test, which rewrites the hook) are counted in `unlabelled_ads` and left out of hook-type groups.
- **Next step.** A hook-type lead names the controlled test that would settle it: `create_variants` with `tested_variable: "hook_type"`.

Formulas: rate = successes / trials with a Wilson interval; the leader vs the runner-up is a rate ratio with a 95% interval (Katz); significance is a
pooled two-proportion test with Holm correction. The wording of each statement is a fixed template. Changing any of these means a new `b` version.

## Steering new ads

When a brand has causal winners, up to five of them (strongest evidence first) are passed to the model when it writes
a new script or variants for that brand: the winning text, what it beat, and the size of the win. The model is told to
take inspiration, never copy the wording, never treat it as a fact about the product, and to ignore it wherever it
conflicts with the brief or the brand rules. A winner that is later corrected away stops steering at once.

## Limits to know about

- One test is one audience, one time, one platform. A winner suggests, and does not prove, that an idea works elsewhere.
- Hookmint cannot see how the ads were really delivered. It trusts the launch mode you give it and the numbers you
  record. Garbage in, garbage out: if the platform did not split the audience fairly, `platform_experiment` is a claim,
  not a fact.
- Numbers are entered by hand or by script. Pulling them straight from Meta, TikTok or Google needs each platform's app
  approval and is not built yet.
- The insights are plain statements written from the numbers by fixed templates, not by a model, so nothing can be
  invented. Each one carries its sample size, interval and method version.
- Pooled benchmarks across brands (opt-in) are not built.

## Data

Two tables, both per account with row-level security and append-only (no UPDATE or DELETE is granted to the application,
the same as the ledger): `ad_links` and `performance_snapshots`. A correction is a newer row for the same day.
