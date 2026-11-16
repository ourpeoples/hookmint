import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, setup } from "../helpers.js";

/**
 * Contract test: the tool names and JSON Schemas clients see are snapshotted. Any change fails the build
 * until the snapshot is updated on purpose (npm run test:update-snapshot), which forces a version decision.
 */
const file = join(dirname(fileURLToPath(import.meta.url)), "tools.snapshot.json");
const { service, ctx } = setup();
const { client } = await connect(service, ctx);
const tools = (await client.listTools()).tools
  .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
  .sort((a, b) => a.name.localeCompare(b.name));
const current = JSON.stringify(tools, null, 2) + "\n";

if (process.env.UPDATE_SNAPSHOT || !existsSync(file)) {
  writeFileSync(file, current);
  console.log("contract snapshot written:", tools.length, "tools");
} else {
  assert.equal(current, readFileSync(file, "utf8"), "Tool contract changed. If intended, bump the version and run: npm run test:update-snapshot");
  console.log("contract snapshot matches:", tools.length, "tools");
}

// Every mutating, spending tool must expose an idempotency key; every tool needs a description.
for (const t of tools) {
  assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
  if (["create_ad", "approve_and_render", "regenerate_scene"].includes(t.name)) {
    assert.ok("idempotency_key" in (t.inputSchema.properties as object), `${t.name} must take idempotency_key`);
    assert.ok((t.inputSchema.required as string[]).includes("idempotency_key"), `${t.name} must require idempotency_key`);
  }
}
await client.close();
process.exit(0);
