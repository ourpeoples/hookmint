import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { type Ctx, fullAccess } from "../src/core/context.js";
import { DEFAULT_LIMITS } from "../src/core/limits.js";
import { AdService, type ServiceOptions } from "../src/core/service.js";
import { createStubProviders, type StubOptions } from "../src/providers/stub.js";
import { buildMcpServer } from "../src/server/mcp.js";

/** The real defaults, except a per-minute request allowance high enough that fast test polling never trips it. */
export const TEST_LIMITS = { ...DEFAULT_LIMITS, requestsPerMinute: 1_000_000_000 };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const key = () => randomUUID();

export async function connect(service: AdService, ctx: Ctx) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(service, ctx).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content[0]?.text ?? "";
    const idx = text.indexOf("\n\n");
    const json = idx >= 0 ? JSON.parse(text.slice(idx + 2)) : null;
    return { isError: !!r.isError, text, json };
  };
  return { client, call };
}

export function setup(stub: StubOptions = {}, svc: Partial<ServiceOptions> = {}, credits = 1000) {
  const stubs = createStubProviders({ delayMs: 15, ...stub });
  const service = new AdService(stubs, { retryBaseMs: 5, limits: TEST_LIMITS, ...svc });
  const ctx = fullAccess("acct_a");
  if (credits) service.grantCredits(ctx.accountId, credits, "test grant");
  return { service, stubs, ctx };
}

export async function waitForStatus(call: Awaited<ReturnType<typeof connect>>["call"], id: string, status: string, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await call("get_ad_status", { job_id: id });
    if (r.json.status === status) return r.json;
    assert.notEqual(r.json.status, "failed", `job failed: ${r.json.error}`);
    await sleep(timeoutMs > 5000 ? 100 : 10);
  }
  throw new Error(`timeout waiting for ${status}`);
}

export async function newReadyAd(call: Awaited<ReturnType<typeof connect>>["call"], extra: Record<string, unknown> = {}) {
  const created = await call("create_ad", {
    prompt: "Spring deep-clean special for busy families",
    duration_s: 15,
    aspect_ratios: ["9:16", "1:1"],
    idempotency_key: key(),
    ...extra,
  });
  assert.equal(created.isError, false, created.text);
  const id = created.json.job_id as string;
  await waitForStatus(call, id, "awaiting_approval");
  return id;
}
