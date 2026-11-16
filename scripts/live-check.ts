/**
 * Live check against the real Claude API. Not part of `npm test`, because it needs a key and spends a little money.
 *
 *   ANTHROPIC_API_KEY=... npm run test:live
 *
 * It generates one real script, two real hook variants and one semantic check, and prints what came back so a
 * person can judge the writing. It asserts only structure, never taste. The key is never printed.
 */
import { fullAccess } from "../src/core/context.js";
import { AdService } from "../src/core/service.js";
import { createProviders } from "../src/providers/index.js";

const setup = createProviders();
if (!setup.claude) {
  console.error("No ANTHROPIC_API_KEY set. Nothing to check.\nRun: ANTHROPIC_API_KEY=... npm run test:live");
  process.exit(2);
}
console.log(`providers: ${setup.summary}\n`);

const service = new AdService(setup.providers);
const ctx = fullAccess("acct_live");
service.grantCredits(ctx.accountId, 1000, "live check");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};

async function until<T>(read: () => T, done: (v: T) => boolean, what: string, timeoutMs = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = read();
    if (done(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

try {
  const kit = service.createBrandKit(ctx, { name: "Sparkle Cleaning Co", colors: ["#0a84ff"], tone: "friendly, plain-spoken, never pushy" });
  service.setBrandRules(ctx, kit.id, {
    rules: [
      { type: "banned_phrase", pattern: "cheapest" },
      { type: "forbidden_claim", pattern: "guaranteed" },
      { type: "semantic", pattern: "Never sound pushy or use pressure tactics" },
    ],
    examples: [{ kind: "tone", text: "We keep it simple: you book, we clean, you relax." }],
  });

  console.log("1. Script");
  const ad = service.createAd(ctx, {
    prompt: "15 second ad for a residential cleaning company offering spring deep-cleans to busy families. Do not mention any discounts or prices.",
    brand_kit_id: kit.id,
    duration_s: 15,
    aspect_ratios: ["9:16"],
    idempotency_key: "live-script-0001",
  });
  await until(() => service.getAd(ctx, ad.id).status, (s) => s !== "scripting", "the script");
  const ready = service.getAd(ctx, ad.id);
  if (ready.status === "failed") throw new Error(`script failed: ${ready.error}`);
  const plan = ready.plans[0];
  console.log(`   hook:  ${plan.hook}\n   angle: ${plan.angle}\n   cta:   ${plan.cta.text}`);
  plan.scenes.forEach((s) => console.log(`   ${s.id} (${s.duration_s}s, ${s.visual_source}): ${s.voiceover}${s.claims.length ? `  [claims: ${s.claims.join("; ")}]` : ""}`));
  check(ready.status === "awaiting_approval", "ad reached awaiting_approval");
  check(plan.scenes.length >= 2, `has ${plan.scenes.length} scenes`);
  check(Math.abs(plan.scenes.reduce((n, s) => n + s.duration_s, 0) - 15) <= 1, "durations add up to 15s");
  const found = service.checkAd(ctx, ad.id);
  console.log(`   brand check: ${found.status}, ${found.findings.length} finding(s)`);
  for (const f of found.findings) console.log(`     - [${f.severity}] ${f.message} ("${f.evidence_quote}")`);

  console.log("\n2. Variants (hook x2)");
  const v = await service.createVariants(ctx, ad.id, { count: 2, tested_variable: "hook", idempotency_key: "live-variants-0001" });
  v.variants.forEach((x, i) => console.log(`   ${i + 1}. ${x.ad.plans[0].hook}   (changed: ${x.diff.map((d) => d.path).join(", ")})`));
  check(v.variants.length === 2, "two variants accepted by the diff engine");

  console.log("\n3. Semantic brand check");
  const sem = await until(() => service.checkAd(ctx, ad.id), (r) => r.semantic_status !== "pending", "the semantic check", 60_000);
  console.log(`   status: ${sem.semantic_status}, discarded: ${sem.semantic_discarded}, findings: ${sem.findings.filter((f) => f.method === "llm").length}`);
  for (const f of sem.findings.filter((x) => x.method === "llm")) console.log(`     - [${f.severity}/${f.confidence}] ${f.message} ("${f.evidence_quote}")`);
  check(sem.semantic_status === "done", "semantic check completed");
} catch (err) {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
}

const u = setup.claude.usage;
console.log(`\nClaude usage: ${u.calls} call(s), ${u.input_tokens} input tokens, ${u.output_tokens} output tokens. Check your Console for the cost.`);
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll structural checks passed. Read the writing above and judge it yourself.");
process.exit(failures ? 1 : 0);
