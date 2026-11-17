import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { type Ctx, fullAccess } from "../src/core/context.js";
import { DEFAULT_LIMITS } from "../src/core/limits.js";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { AdService, type ServiceOptions } from "../src/core/service.js";
import type { Store } from "../src/core/store.js";
import { migrate } from "../src/db/migrate.js";
import { PgStore } from "../src/db/pg-store.js";
import type { Providers } from "../src/providers/types.js";
import { createStubProviders, type StubOptions } from "../src/providers/stub.js";
import { buildMcpServer } from "../src/server/mcp.js";

/** The real defaults, except a per-minute request allowance high enough that fast test polling never trips it. */
export const TEST_LIMITS = { ...DEFAULT_LIMITS, requestsPerMinute: 1_000_000_000 };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const key = () => randomUUID();

/** Set HOOKMINT_TEST_STORE=postgres and HOOKMINT_TEST_DATABASE_URL (a superuser URL) to run a suite against Postgres. */
export const USING_PG = process.env.HOOKMINT_TEST_STORE === "postgres";
const ROLE_PASSWORD = "hookmint_test_pw";
export function roleUrl(adminUrl: string, role: string) {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = ROLE_PASSWORD;
  return u.toString();
}
/** A store for one service: a private copy of the schema in Postgres, or undefined to use memory. */
export function newStore(retryBaseMs = 5): Store | undefined {
  if (!USING_PG) return undefined;
  const admin = process.env.HOOKMINT_TEST_DATABASE_URL;
  if (!admin) throw new Error("HOOKMINT_TEST_DATABASE_URL is not set.");
  const schema = `hk_test_${randomBytes(5).toString("hex")}`;
  return new PgStore({
    appUrl: roleUrl(admin, "hookmint_app"),
    workerUrl: roleUrl(admin, "hookmint_worker"),
    schema,
    retryBaseMs,
    prepare: async () => {
      await migrate(admin, { schema });
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      try {
        await c.query(`ALTER ROLE hookmint_app PASSWORD '${ROLE_PASSWORD}'`);
        await c.query(`ALTER ROLE hookmint_worker PASSWORD '${ROLE_PASSWORD}'`);
      } finally {
        await c.end();
      }
    },
  });
}
export const newService = (providers: Providers, opts: Partial<ServiceOptions> = {}) => new AdService(providers, opts, newStore(opts.retryBaseMs ?? 5));

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

export async function setup(stub: StubOptions = {}, svc: Partial<ServiceOptions> = {}, credits = 1000) {
  const stubs = createStubProviders({ delayMs: 15, ...stub });
  const service = newService(stubs, { retryBaseMs: 5, limits: TEST_LIMITS, ...svc });
  const ctx = fullAccess("acct_a");
  if (credits) await service.grantCredits(ctx.accountId, credits, "test grant");
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
