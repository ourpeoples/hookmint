import assert from "node:assert/strict";
import { brandAssets, checkBuiltins } from "../src/brand/builtin.js";
import { checkPlan } from "../src/brand/check.js";
import { buildRules } from "../src/brand/rules.js";
import { validateSemantic } from "../src/brand/semantic.js";
import { fullAccess } from "../src/core/context.js";
import { PLATFORM_RULES } from "../src/core/platforms.js";
import { type BrandKit, ScenePlan } from "../src/core/schemas.js";
import { connect, key, setup, waitForStatus } from "./helpers.js";
import { auditOf, verifyAudit, rulesOf } from "./inspect.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok", name);
};

const plan = (over: Partial<ScenePlan> = {}): ScenePlan => ({
  schema_version: "1.1",
  template: { id: "t", version: "1" },
  hook: "Spring clean, done for you",
  hook_id: "h1",
  angle: "price",
  variant_group_id: "vg1",
  cta: { text: "Book today" },
  aspect_ratios: ["9:16"],
  scenes: [
    { id: "s1", duration_s: 5, visual_prompt: "a", visual_source: "stock", voiceover: "We are the cheapest and cheaper than rivals.", claims: ["Guaranteed results in 24 hours"] },
    { id: "s2", duration_s: 5, visual_prompt: "b", visual_source: "stock", voiceover: "Call 555-0100 now.", on_screen_text: "Licensed and insured", claims: [] },
  ],
  ...over,
});
const rules = (...r: Parameters<typeof buildRules>[0]) => buildRules(r);

await test("banned phrase: case-insensitive, whole words only, quotes the match", async () => {
  const f = checkPlan(plan(), rules({ type: "banned_phrase", pattern: "CHEAP" }), 1);
  assert.equal(f.length, 0); // "cheapest" and "cheaper" are different words
  const g = checkPlan(plan(), rules({ type: "banned_phrase", pattern: "cheapest" }), 3);
  assert.equal(g.length, 1);
  assert.equal(g[0].evidence_quote, "cheapest");
  assert.equal(g[0].scene_id, "s1");
  assert.equal(g[0].field, "voiceover");
  assert.equal(g[0].rule_version, 3);
  assert.equal(g[0].method, "deterministic");
  assert.equal(g[0].confidence, null);
  assert.equal(g[0].advisory, true);
  assert.equal(g[0].severity, "warn");
});

await test("forbidden claim: found in claims[] and defaults to block", async () => {
  const f = checkPlan(plan(), rules({ type: "forbidden_claim", pattern: "guaranteed results" }), 1);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "block");
  assert.equal(f[0].field, "claims[0]");
});

await test("required disclaimer: missing blocks, present passes, whitespace and case ignored", async () => {
  const missing = checkPlan(plan(), rules({ type: "required_disclaimer", pattern: "Results may vary" }), 1);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, "block");
  assert.match(missing[0].suggested_fix, /scene s2/);
  const withIt = plan({ scenes: [plan().scenes[0], { ...plan().scenes[1], on_screen_text: "Licensed and insured.  RESULTS   may vary" }] });
  assert.equal(checkPlan(withIt, rules({ type: "required_disclaimer", pattern: "results may vary" }), 1).length, 0);
});

await test("regex rules: work, and unsafe or invalid patterns are rejected at save time", async () => {
  const f = checkPlan(plan(), rules({ type: "regex", pattern: "\\b555-\\d{4}\\b", severity: "info" }), 1);
  assert.equal(f.length, 1);
  assert.equal(f[0].evidence_quote, "555-0100");
  assert.throws(() => rules({ type: "regex", pattern: "(a+)+$" }), /nested quantifiers/);
  assert.throws(() => rules({ type: "regex", pattern: "(\\w)\\1" }), /backreferences/);
  assert.throws(() => rules({ type: "regex", pattern: "([" }), /invalid regular expression/);
  assert.throws(() => rules({ type: "semantic", pattern: "Never sound pushy", severity: "block" }), /cannot block/);
});

await test("findings are sorted with blocks first", async () => {
  const f = checkPlan(plan(), rules({ type: "banned_phrase", pattern: "cheapest" }, { type: "forbidden_claim", pattern: "guaranteed results" }), 1);
  assert.deepEqual(f.map((x) => x.severity), ["block", "warn"]);
});

await test("semantic validator: keeps cited verbatim findings, discards the rest, never blocks", async () => {
  const r = rules({ type: "semantic", pattern: "Never sound pushy" }, { type: "banned_phrase", pattern: "x" });
  const raw = [
    { rule_id: "r1", severity: "block" as const, scene_id: "s2", evidence_quote: "call 555-0100  NOW.", message: "Pushy", confidence: "medium" as const },
    { rule_id: "r1", severity: "warn" as const, evidence_quote: "text that is not in the plan", message: "Invented", confidence: "high" as const },
    { rule_id: "r9", severity: "warn" as const, evidence_quote: "Book today", message: "Unknown rule", confidence: "high" as const },
    { rule_id: "r2", severity: "warn" as const, evidence_quote: "Book today", message: "Not a semantic rule", confidence: "high" as const },
    { rule_id: "r1", severity: "warn" as const, scene_id: "s1", evidence_quote: "Book today", message: "Wrong scene", confidence: "high" as const },
    { rule_id: "r1", severity: "warn" as const, evidence_quote: "Book today", message: "No confidence" } as never,
  ];
  const { findings, discarded } = validateSemantic(raw, plan(), r, 4);
  assert.equal(findings.length, 1);
  assert.equal(discarded, 5);
  assert.equal(findings[0].severity, "warn"); // block was capped
  assert.equal(findings[0].method, "llm");
  assert.equal(findings[0].confidence, "medium");
  assert.equal(findings[0].scene_id, "s2");
  assert.equal(findings[0].rule_version, 4);
});

await test("end to end: rules block approval, override is audited, fixing the script clears it", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const kit = await call("create_brand_kit", { name: "Sparkle" });
  const kitId = kit.json.brand_kit_id as string;
  const saved = await call("set_brand_rules", {
    brand_kit_id: kitId,
    rules: [{ type: "forbidden_claim", pattern: "guaranteed results" }, { type: "banned_phrase", pattern: "cheap", severity: "warn" }],
    examples: [{ kind: "tone", text: "Friendly, never pushy." }],
  });
  assert.equal(saved.json.version, 1);

  const created = await call("create_ad", { prompt: "Offer guaranteed results for a spring clean", brand_kit_id: kitId, duration_s: 15, idempotency_key: key() });
  const id = created.json.job_id as string;
  await waitForStatus(call, id, "awaiting_approval");

  const check = await call("check_ad", { job_id: id });
  assert.equal(check.json.status, "block");
  assert.equal(check.json.rule_set_version, 1);
  assert.equal(check.json.findings[0].rule_id, "r1");
  assert.equal((await call("get_ad_status", { job_id: id })).json.check.status, "block"); // view carries the check too

  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  const before = await service.getBalance(ctx);
  const blocked = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.match(blocked.text, /^\[blocked_by_rule\]/);
  assert.deepEqual(await service.getBalance(ctx), before); // nothing reserved
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "awaiting_approval");

  const tooShort = await call("approve_and_render", { job_id: id, max_credits: est, override_reason: "short", idempotency_key: key() });
  assert.equal(tooShort.isError, true);
  assert.match(tooShort.text, /override_reason/);
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "awaiting_approval");

  // Fix the script: the hook is the plan-level text that carried the claim.
  await call("update_script", { job_id: id, hook: "Spring clean, done for you" });
  const fixed = await call("check_ad", { job_id: id });
  assert.notEqual(fixed.json.status, "block");
  assert.ok(fixed.json.findings.every((f: { rule_id: string }) => f.rule_id.startsWith("builtin.")), "only the built-in advice is left; the brand's own rules are satisfied");
  const ok = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.equal(ok.isError, false);
  await waitForStatus(call, id, "completed");
  assert.equal((await auditOf(service)).some((a) => a.action === "ad.override"), false);
});

await test("override with a reason goes ahead and is recorded with the findings", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "forbidden_claim", pattern: "guaranteed results" }] });
  const id = (await call("create_ad", { prompt: "Offer guaranteed results for a spring clean", brand_kit_id: kitId, duration_s: 15, idempotency_key: key() })).json.job_id as string;
  await waitForStatus(call, id, "awaiting_approval");
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  const go = await call("approve_and_render", { job_id: id, max_credits: est, override_reason: "Owner confirmed the guarantee is real and in writing.", idempotency_key: key() });
  assert.equal(go.isError, false, go.text);
  await waitForStatus(call, id, "completed");
  const entry = (await auditOf(service)).find((a) => a.action === "ad.override")!;
  assert.ok(entry);
  const d = entry.detail as { reason: string; findings: { rule_id: string; evidence_quote: string }[] };
  assert.match(d.reason, /guarantee is real/);
  assert.equal(d.findings[0].rule_id, "r1");
  assert.equal(await verifyAudit(service, ctx.accountId), true);
});

await test("editing rules creates a new version that later findings cite; examples never block", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "placeholder" }], examples: [{ kind: "past_winner", text: "Placeholder hook that won" }] });
  const id = (await call("create_ad", { prompt: "Spring deep-clean special for families", brand_kit_id: kitId, duration_s: 15, idempotency_key: key() })).json.job_id as string;
  await waitForStatus(call, id, "awaiting_approval");
  const v1 = await call("check_ad", { job_id: id });
  assert.ok(v1.json.findings.length > 0);
  assert.equal(v1.json.findings[0].rule_version, 1);
  assert.equal(v1.json.status, "warn"); // warn does not block approval
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  assert.equal((await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "placeholder", severity: "info" }] })).json.version, 2);
  const v2 = await call("check_ad", { job_id: id });
  const own = v2.json.findings.filter((f: { rule_id: string }) => !f.rule_id.startsWith("builtin."));
  assert.equal(own[0].rule_version, 2);
  assert.ok(own.every((f: { severity: string }) => f.severity === "info"), "the brand's own findings are info only, which do not warn or block");
  assert.ok(v2.json.counts.info > 0);
  assert.equal((await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() })).isError, false);
});

await test("tenant isolation and scopes apply to brand rules", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  const other = await connect(service, fullAccess("acct_b"));
  assert.match((await other.call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "x" }] })).text, /^\[not_found\]/);
  const readOnly = await connect(service, { accountId: ctx.accountId, scopes: new Set(["ads:read"]) });
  assert.match((await readOnly.call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "x" }] })).text, /^\[forbidden\]/);
  assert.match((await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "regex", pattern: "(a+)+$" }] })).text, /^\[invalid_input\]/);
  assert.equal((await rulesOf(service, kitId)) !== undefined, false); // rejected input saved nothing
});

await test("built-in checks: platform text and length, benefit, resolution and brand assets, all advisory and all named", async () => {
  const kit = (over: Partial<BrandKit> = {}): BrandKit => ({ id: "bk", name: "Sparkle", colors: ["#112233"], ...over });
  const good = plan({ platform: "tiktok", product_benefit: "Get a spotless home without lifting a finger.", resolution: "A relaxed owner enjoys the clean home.", scenes: [
    { id: "s1", duration_s: 5, visual_prompt: "Sparky the mascot waves", visual_source: "stock", voiceover: "Meet Sparky.", on_screen_text: "Spark joy", claims: [] },
    { id: "s2", duration_s: 5, visual_prompt: "b", visual_source: "stock", voiceover: "Call now.", on_screen_text: "Book", claims: [] },
  ] });
  const rich = kit({ logo_url: "https://example.com/l.png", distinctive_assets: [{ type: "slogan", value: "Spark joy" }, { type: "mascot", value: "Sparky" }] });
  assert.deepEqual(checkBuiltins(good, { kit: rich, logoReady: true }), [], "a complete plan with a rich kit has nothing to flag");
  assert.deepEqual(brandAssets(rich).map((a) => a.type), ["logo", "color", "slogan", "mascot"]);
  assert.equal(brandAssets(kit({ distinctive_assets: [{ type: "slogan", value: "Hi" }, { type: "slogan", value: " hi " }] })).length, 2, "the same asset twice counts once");

  const ids = (f: ReturnType<typeof checkBuiltins>) => f.map((x) => x.rule_id).sort();
  const bare = checkBuiltins(plan({ scenes: good.scenes }), { kit: kit(), logoReady: false });
  assert.deepEqual(ids(bare), ["builtin.brand_assets", "builtin.brand_assets_early", "builtin.product_benefit", "builtin.resolution"]);
  assert.ok(bare.every((f) => f.severity === "warn" && f.method === "deterministic" && f.advisory), "never blocks");

  const noText = plan({ ...good, scenes: [{ ...good.scenes[0], on_screen_text: undefined }, good.scenes[1]] });
  assert.ok(ids(checkBuiltins(noText, { kit: rich, logoReady: true })).includes("builtin.platform_overlay"));
  assert.ok(!ids(checkBuiltins({ ...noText, platform: "youtube" }, { kit: rich, logoReady: true })).includes("builtin.platform_overlay"), "YouTube does not require overlay text");
  const long = plan({ ...good, platform: "meta", scenes: Array.from({ length: 4 }, (_, i) => ({ ...good.scenes[0], id: `s${i + 1}`, duration_s: 9 })) });
  assert.ok(ids(checkBuiltins(long, { kit: rich, logoReady: true })).includes("builtin.platform_duration"));
  assert.ok(!ids(checkBuiltins({ ...long, platform: "youtube" }, { kit: rich, logoReady: true })).includes("builtin.platform_duration"));
  assert.equal(PLATFORM_RULES.tiktok.hook_window_s, 1);

  // pace: a line the voice cannot say inside its scene is flagged with the scene and the numbers
  const fast = plan({ ...good, scenes: [{ ...good.scenes[0], duration_s: 4, voiceover: "Hold on, put the notebook down. Akye helps you schedule your jobs and send invoices in one place." }, good.scenes[1]] });
  const pace = checkBuiltins(fast, { kit: rich, logoReady: true }).filter((f) => f.rule_id === "builtin.voice_pace");
  assert.equal(pace.length, 1);
  assert.equal(pace[0].scene_id, "s1");
  assert.match(pace[0].message, /18 words for 4 seconds/);
  assert.equal(pace[0].severity, "warn", "advice only");
  const tenWords = plan({ ...good, scenes: [{ ...good.scenes[0], duration_s: 4, voiceover: "One two three four five six seven eight nine ten." }, good.scenes[1]] });
  assert.ok(!ids(checkBuiltins(tenWords, { kit: rich, logoReady: true })).includes("builtin.voice_pace"), "the 2.5 words a second the scripts are asked for is fine");

  const echo = plan({ ...good, product_benefit: good.hook });
  assert.ok(ids(checkBuiltins(echo, { kit: rich, logoReady: true })).includes("builtin.product_benefit"), "a benefit that just repeats the hook is not a benefit");
  const early = checkBuiltins(good, { kit: rich, logoReady: false }); // logo not downloaded yet, so it will not be in the video
  assert.deepEqual(early, [], "colour and the named slogan and mascot are still two early assets");
  const late = checkBuiltins(plan({ ...good, scenes: [{ ...good.scenes[0], visual_prompt: "a", voiceover: "Hello.", on_screen_text: "Hi" }, good.scenes[1]] }), { kit: rich, logoReady: false });
  assert.deepEqual(ids(late), ["builtin.brand_assets_early"], "assets named only later are not early");
});

await test("end to end: platform and brand assets travel through create_brand_kit and create_ad, and the built-in advice appears in check_ad", async () => {
  const { service, ctx } = await setup();
  const { call } = await connect(service, ctx);
  const bare = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  const kit = await call("create_brand_kit", { name: "Sparkle2", colors: ["#112233"], distinctive_assets: [{ type: "slogan", value: "Spark joy" }, { type: "character", value: "Sparky" }] });
  assert.equal(kit.isError, false, kit.text);
  const got = (await call("get_brand_kit", { brand_kit_id: kit.json.brand_kit_id })).json;
  assert.equal((got.kit ?? got).distinctive_assets.length, 2, "the assets are stored with the kit");
  assert.equal((await call("create_brand_kit", { name: "x", distinctive_assets: [{ type: "banner", value: "x" }] })).isError, true, "an unknown asset type is refused");

  const too = await call("create_ad", { prompt: "A spring clean offer for homes", brand_kit_id: bare, duration_s: 45, platform: "meta", idempotency_key: key() });
  assert.equal(too.isError, true);
  assert.match(too.text, /at most 30 seconds/);

  const made = await call("create_ad", { prompt: "A spring clean offer for homes", brand_kit_id: bare, duration_s: 15, platform: "tiktok", idempotency_key: key() });
  assert.equal(made.isError, false, made.text);
  const id = made.json.job_id as string;
  const st = await waitForStatus(call, id, "awaiting_approval");
  assert.equal(st.plan.platform, "tiktok", "the server sets the platform from the request");
  assert.ok(st.plan.product_benefit && st.plan.resolution);
  const c = await call("check_ad", { job_id: id });
  assert.ok(c.json.findings.some((f: { rule_id: string }) => f.rule_id === "builtin.brand_assets"));
  assert.notEqual(c.json.status, "block", "advice never blocks");
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  assert.equal((await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() })).isError, false, "and approval still works");

  const noPlat = await call("create_ad", { prompt: "A spring clean offer for homes", duration_s: 15, idempotency_key: key() });
  assert.equal((await waitForStatus(call, noPlat.json.job_id, "awaiting_approval")).plan.platform, undefined);
});

console.log(`brand passed: ${n} checks`);
process.exit(0);
