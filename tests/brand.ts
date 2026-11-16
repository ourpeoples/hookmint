import assert from "node:assert/strict";
import { checkPlan } from "../src/brand/check.js";
import { buildRules } from "../src/brand/rules.js";
import { validateSemantic } from "../src/brand/semantic.js";
import { fullAccess } from "../src/core/context.js";
import { ScenePlan } from "../src/core/schemas.js";
import { connect, key, setup, waitForStatus } from "./helpers.js";

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
  const { service, ctx } = setup();
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
  const before = service.getBalance(ctx);
  const blocked = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.match(blocked.text, /^\[blocked_by_rule\]/);
  assert.deepEqual(service.getBalance(ctx), before); // nothing reserved
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "awaiting_approval");

  const tooShort = await call("approve_and_render", { job_id: id, max_credits: est, override_reason: "short", idempotency_key: key() });
  assert.equal(tooShort.isError, true);
  assert.match(tooShort.text, /override_reason/);
  assert.equal((await call("get_ad_status", { job_id: id })).json.status, "awaiting_approval");

  // Fix the script: the hook is the plan-level text that carried the claim.
  await call("update_script", { job_id: id, hook: "Spring clean, done for you" });
  const fixed = await call("check_ad", { job_id: id });
  assert.equal(fixed.json.status, "pass");
  const ok = await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  assert.equal(ok.isError, false);
  await waitForStatus(call, id, "completed");
  assert.equal(service.store.audit.some((a) => a.action === "ad.override"), false);
});

await test("override with a reason goes ahead and is recorded with the findings", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "forbidden_claim", pattern: "guaranteed results" }] });
  const id = (await call("create_ad", { prompt: "Offer guaranteed results for a spring clean", brand_kit_id: kitId, duration_s: 15, idempotency_key: key() })).json.job_id as string;
  await waitForStatus(call, id, "awaiting_approval");
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  const go = await call("approve_and_render", { job_id: id, max_credits: est, override_reason: "Owner confirmed the guarantee is real and in writing.", idempotency_key: key() });
  assert.equal(go.isError, false, go.text);
  await waitForStatus(call, id, "completed");
  const entry = service.store.audit.find((a) => a.action === "ad.override")!;
  assert.ok(entry);
  const d = entry.detail as { reason: string; findings: { rule_id: string; evidence_quote: string }[] };
  assert.match(d.reason, /guarantee is real/);
  assert.equal(d.findings[0].rule_id, "r1");
  assert.equal(service.store.verifyAudit(ctx.accountId), true);
});

await test("editing rules creates a new version that later findings cite; examples never block", async () => {
  const { service, ctx } = setup();
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
  assert.equal(v2.json.findings[0].rule_version, 2);
  assert.equal(v2.json.status, "pass"); // info-only findings do not warn or block
  assert.ok(v2.json.counts.info > 0);
  assert.equal((await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() })).isError, false);
});

await test("tenant isolation and scopes apply to brand rules", async () => {
  const { service, ctx } = setup();
  const { call } = await connect(service, ctx);
  const kitId = (await call("create_brand_kit", { name: "Sparkle" })).json.brand_kit_id as string;
  const other = await connect(service, fullAccess("acct_b"));
  assert.match((await other.call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "x" }] })).text, /^\[not_found\]/);
  const readOnly = await connect(service, { accountId: ctx.accountId, scopes: new Set(["ads:read"]) });
  assert.match((await readOnly.call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "banned_phrase", pattern: "x" }] })).text, /^\[forbidden\]/);
  assert.match((await call("set_brand_rules", { brand_kit_id: kitId, rules: [{ type: "regex", pattern: "(a+)+$" }] })).text, /^\[invalid_input\]/);
  assert.equal(service.store.brandRules.has(kitId), false); // rejected input saved nothing
});

console.log(`brand passed: ${n} checks`);
process.exit(0);
