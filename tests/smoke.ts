import assert from "node:assert/strict";
import { connect, key, newReadyAd, setup, waitForStatus } from "./helpers.js";
import { verifyAudit } from "./inspect.js";

const { service, ctx } = await setup();
const { client, call } = await connect(service, ctx);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, [
  "approve_and_render", "cancel_ad", "check_ad", "compare_variants", "create_ad", "create_brand_kit", "create_variants", "estimate_cost",
  "get_ad_status", "get_brand_kit", "get_download_url", "get_insights", "get_performance", "get_storyboard", "link_ad", "list_ads", "plan_test",
  "record_performance", "regenerate_scene", "set_brand_rules", "update_script",
]);

// structured results: three tools declare their output, every successful tool also returns its data as structured content
const declared = (await client.listTools()).tools.filter((t) => t.outputSchema).map((t) => t.name).sort();
assert.deepEqual(declared, ["estimate_cost", "get_ad_status", "get_insights"]);
{
  const raw = (await client.callTool({ name: "get_insights", arguments: { brand_kit_id: "bk_missing" } })) as { isError?: boolean; structuredContent?: unknown };
  assert.equal(raw.isError, true, "an error result is not held to the output schema");
  assert.equal(raw.structuredContent, undefined);
}

const kit = await call("create_brand_kit", { name: "Sparkle Cleaning", colors: ["#0a84ff"] });
const id = await newReadyAd(call, { brand_kit_id: kit.json.brand_kit_id });

// Free previews before any spend.
const sb = await call("get_storyboard", { job_id: id });
assert.equal(sb.json.total_s, 15);
const est = await call("estimate_cost", { job_id: id });
assert.ok(est.json.credits > 0);
{
  const raw = (await client.callTool({ name: "estimate_cost", arguments: { job_id: id } })) as { structuredContent?: Record<string, unknown> };
  assert.deepEqual(raw.structuredContent, est.json, "the structured result is exactly the JSON in the text block");
  const status = (await client.callTool({ name: "get_ad_status", arguments: { job_id: id } })) as { structuredContent?: Record<string, unknown> };
  assert.equal(status.structuredContent?.job_id, id);
  const other = (await client.callTool({ name: "get_storyboard", arguments: { job_id: id } })) as { structuredContent?: Record<string, unknown> };
  assert.ok(other.structuredContent && "frames" in other.structuredContent, "tools without a declared schema still return structured content");
}

// Edits create new plan versions; duration guard holds.
const edited = await call("update_script", { job_id: id, hook: "Spring clean, done for you", scenes: [{ scene_id: "s1", voiceover: "New voiceover" }] });
assert.equal(edited.json.plan_version, 2);
assert.equal(edited.json.plan.schema_version, "1.1");
assert.equal((await call("update_script", { job_id: id, scenes: [{ scene_id: "s1", duration_s: 10 }] })).isError, true);

// Approval needs max_credits at or above the estimate.
const est2 = await call("estimate_cost", { job_id: id });
const before = (await call("get_ad_status", { job_id: id })).json.balance.available;
await call("approve_and_render", { job_id: id, max_credits: est2.json.credits, idempotency_key: key() });
const done = await waitForStatus(call, id, "completed");
assert.equal(done.renders.length, 2);
assert.equal(done.progress_pct, 100);
assert.equal(done.balance.available, before - est2.json.credits);
assert.equal(done.balance.held, 0);

assert.equal((await call("update_script", { job_id: id, hook: "x" })).isError, true);
assert.equal((await call("list_ads", { limit: 5 })).json.ads.length, 1);
assert.ok(await verifyAudit(service, ctx.accountId));

console.log("smoke passed:", tools.length, "tools, full lifecycle with spend and settlement");
await client.close();
