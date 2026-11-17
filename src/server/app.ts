import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fullAccess, type Ctx } from "../core/context.js";
import { AdError, HTTP_STATUS } from "../core/errors.js";
import { FailureLimiter } from "../core/limits.js";
import { silentLogger, type Logger } from "../core/logger.js";
import { randomBytes } from "node:crypto";
import { ApiKeys, bearerToken } from "./api-keys.js";
import { looksLikeJwt, type OAuthVerifier } from "./oauth.js";
import { ExampleInput, RuleInput } from "../brand/rules.js";
import { AspectRatio } from "../core/schemas.js";
import { TESTED_VARIABLES } from "../variants/diff.js";
import type { AdService } from "../core/service.js";
import { z } from "zod";
import { serveFile } from "../render/serve.js";
import { buildMcpServer } from "./mcp.js";
import { adView, envelope } from "./views.js";

export interface AppOptions {
  /** Clock for the failure limiter. Tests replace it. */
  now?: () => number;
  /** API keys (hashed, with expiry and revocation). A plain token -> context map is accepted for tests. No keys = open (local dev only). */
  apiKeys?: ApiKeys | Map<string, Ctx>;
  devCtx?: Ctx;
  /** Accepts OAuth 2.1 access tokens from an identity provider, alongside API keys. */
  oauth?: OAuthVerifier;
  logger?: Logger;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
  /** Browser origins allowed to call the API. Empty means no cross-origin access. Never "*". */
  corsOrigins?: string[];
  /** Sends Strict-Transport-Security. Turn on when the server is only reachable over HTTPS. */
  hsts?: boolean;
  lifecycle?: Lifecycle;
}

/** Shared flag so a shutdown signal can make /readyz report not-ready while in-flight requests finish. */
export class Lifecycle {
  draining = false;
}

export const DEFAULT_MAX_BODY = 1_048_576;

const CreateBody = z.object({
  prompt: z.string().min(10),
  brand_kit_id: z.string().optional(),
  duration_s: z.number().int().min(6).max(60).default(15),
  aspect_ratios: z.array(AspectRatio).min(1).default(["9:16"]),
});
const ApproveBody = z.object({ max_credits: z.number().int().min(0), override_reason: z.string().min(10).max(500).optional() });
const VariantsBody = z.object({ count: z.number().int().min(1).max(5), tested_variable: z.enum(TESTED_VARIABLES) });
const RulesBody = z.object({ rules: z.array(RuleInput).max(200), examples: z.array(ExampleInput).max(50).optional() });

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new AdError("payload_too_large", `Request body is larger than the ${max} byte limit.`, undefined, { retry: false });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new AdError("payload_too_large", `Request body is larger than the ${max} byte limit.`, undefined, { retry: false });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  if (!/^application\/(json|[a-z.+-]*\+json)\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new AdError("unsupported_media_type", "Send the body as application/json.", undefined, { retry: false });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdError("invalid_input", "Request body is not valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra }).end(JSON.stringify(body));
}

export function createApp(service: AdService, opts: AppOptions = {}): Server {
  const keys = opts.apiKeys instanceof Map ? ApiKeys.fromMap(opts.apiKeys) : opts.apiKeys;
  const log = opts.logger ?? silentLogger;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const lifecycle = opts.lifecycle ?? new Lifecycle();
  const origins = new Set(opts.corsOrigins ?? []);
  if (origins.has("*")) throw new Error('corsOrigins must list exact origins. "*" is not allowed because requests carry bearer keys.');
  const oauth = opts.oauth;
  const bad = (message: string) => new AdError("unauthorized", message, undefined, { retry: false });
  const authenticate = async (req: IncomingMessage): Promise<Ctx> => {
    if ((!keys || keys.size === 0) && !oauth) return opts.devCtx ?? fullAccess("acct_dev");
    const token = bearerToken(req.headers.authorization);
    if (!token) throw bad("Missing credentials. Send an API key or an OAuth access token as a Bearer token.");
    let message = oauth ? "Missing or invalid credentials." : "Missing or invalid API key.";
    if (keys && keys.size) {
      const r = keys.authenticate(token);
      if (r.ok) return r.ctx;
      if (r.reason !== "unknown") message = `This API key has ${r.reason === "expired" ? "expired" : "been revoked"}.`;
    }
    if (oauth && looksLikeJwt(token)) {
      const r = await oauth.verify(token);
      if (r.ok) return r.ctx;
      // The token itself was fine; it is the sign-in that is not allowed here, or the provider is down. Neither is a guessed credential.
      if (r.reason === "account" || r.reason === "scope") throw new AdError("forbidden", r.description, undefined, { retry: false });
      if (r.reason === "unavailable") throw new AdError("provider_unavailable", r.description);
      message = r.description;
    }
    throw bad(message);
  };
  const challenge = (req: IncomingMessage, message: string) => {
    const parts = ['Bearer realm="hookmint"'];
    if (oauth) parts.push(`resource_metadata="${oauth.metadata().resource.replace(/\/mcp$/, "").replace(/\/+$/, "")}/.well-known/oauth-protected-resource"`);
    if (req.headers.authorization) parts.push('error="invalid_token"', `error_description="${message.replace(/["\\\r\n]/g, " ").slice(0, 200)}"`);
    return parts.join(", ");
  };

  // Counts only requests that already failed their credential check, so a valid key or link is never locked out.
  const failures = new FailureLimiter(service.limits.authFailuresPer10Min, undefined, opts.now);
  const who = (req: IncomingMessage) => req.socket.remoteAddress ?? "unknown";

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const inbound = req.headers["x-request-id"];
    const requestId = typeof inbound === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : `req_${randomBytes(8).toString("hex")}`;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (opts.hsts) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    let accountId: string | undefined;
    let pathForLog = "?";
    res.on("finish", () =>
      log.info("request", { request_id: requestId, method: req.method, path: pathForLog, status: res.statusCode, ms: Date.now() - started, account: accountId }),
    );
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      // Query strings carry signed link parameters, so only the path is ever logged. File ids are not secrets.
      pathForLog = path.length > 120 ? `${path.slice(0, 120)}…` : path;

      // ---- Cross-origin access: exact allow-list only. A request without an Origin header is not a browser, so it is unaffected. ----
      const origin = req.headers.origin;
      if (origin && origins.has(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-expose-headers", "x-request-id, retry-after");
      }
      if (req.method === "OPTIONS") {
        if (!origin || !origins.has(origin)) return void res.writeHead(403).end();
        return void res
          .writeHead(204, {
            "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
            "access-control-allow-headers": "authorization, content-type, idempotency-key, mcp-protocol-version, mcp-session-id, x-request-id",
            "access-control-max-age": "600",
          })
          .end();
      }

      // ---- Liveness and readiness. No secrets, no account data, no credentials needed. ----
      if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, { status: "ok" });
      if (path === "/readyz" && (req.method === "GET" || req.method === "HEAD")) {
        const open = service.openBreakers();
        const database = await service.store.ping().then(() => true, () => false);
        const ready = !lifecycle.draining && database;
        return send(res, ready ? 200 : 503, { status: lifecycle.draining ? "draining" : database ? "ready" : "database_unavailable", store: service.storeKind, providers_paused: open });
      }

      // ---- OAuth discovery (RFC 9728): tells a client which identity provider to use. Public, no secrets. ----
      if ((path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") && (req.method === "GET" || req.method === "HEAD")) {
        if (!oauth) return void res.writeHead(404).end();
        return send(res, 200, oauth.metadata(), { "cache-control": "public, max-age=300" });
      }

      // ---- Finished videos. The signed, expiring link is the authorisation, so this comes before the API key check. ----
      const file = /^\/files\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (file) {
        if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD" }).end();
        const acct = url.searchParams.get("acct");
        const verdict = service.downloads.verify({ renderId: file[1], acct, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") });
        if (verdict !== "ok") {
          if (verdict === "invalid") failures.failed(who(req)); // an expired link was genuine, so it does not count as a guess
          return void res.writeHead(403, { "content-type": "text/plain" }).end(verdict === "expired" ? "This link has expired. Ask for a new one." : "This link is not valid.");
        }
        const rec = await service.renderFile(file[1], acct!);
        if (!rec) return void res.writeHead(404).end();
        return void (await serveFile(req, res, {
          path: rec.path,
          type: "video/mp4",
          headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": `inline; filename="hookmint-${file[1]}.mp4"` },
        }));
      }

      let ctx: Ctx;
      try {
        ctx = await authenticate(req);
        accountId = ctx.accountId;
      } catch (err) {
        if (err instanceof AdError && err.code === "unauthorized") failures.failed(who(req));
        throw err;
      }

      // ---- MCP over Streamable HTTP (stateless transport per request) ----
      if (path === "/mcp") {
        if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
        const body = await readJson(req, maxBody);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = buildMcpServer(service, ctx);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        return void (await transport.handleRequest(req, res, body));
      }

      // ---- REST /v1: same service layer as the MCP tools ----
      if (path.startsWith("/v1/")) service.admit(ctx); // MCP calls are counted per tool instead
      const m = path.match(/^\/v1\/ads(?:\/([^/]+))?(?:\/(estimate|approve|cancel|storyboard|check|variants))?$/);
      if (m) {
        const [, id, action] = m;
        if (!id && req.method === "POST") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string") throw new AdError("invalid_input", "Idempotency-Key header is required.");
          const body = CreateBody.safeParse(await readJson(req, maxBody));
          if (!body.success) throw new AdError("invalid_input", body.error.message);
          const ad = await service.createAd(ctx, { ...body.data, idempotency_key: key });
          return send(res, 201, await adView(service, ctx, ad));
        }
        if (!id && req.method === "GET") {
          const ads = (await service.listAds(ctx, 20)).map((a) => ({ job_id: a.id, status: a.status, created_at: a.created_at }));
          return send(res, 200, envelope({ ads }));
        }
        if (id && !action && req.method === "GET") return send(res, 200, await adView(service, ctx, await service.getAd(ctx, id)));
        if (id && action === "estimate" && req.method === "GET") return send(res, 200, envelope(await service.estimateCost(ctx, id)));
        if (id && action === "storyboard" && req.method === "GET") return send(res, 200, envelope(await service.getStoryboard(ctx, id)));
        if (id && action === "check" && req.method === "GET") return send(res, 200, envelope(await service.checkAd(ctx, id)));
        if (id && action === "variants" && req.method === "POST") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string") throw new AdError("invalid_input", "Idempotency-Key header is required.");
          const body = VariantsBody.safeParse(await readJson(req, maxBody));
          if (!body.success) throw new AdError("invalid_input", body.error.message);
          const r = await service.createVariants(ctx, id, { ...body.data, idempotency_key: key });
          return send(res, 201, envelope({
            variant_group_id: r.variant_group_id,
            tested_variable: r.tested_variable,
            base_job_id: r.base_ad_id,
            variants: r.variants.map((v) => ({ job_id: v.ad.id, status: v.ad.status, diff: v.diff, check: v.check })),
          }));
        }
        if (id && action === "cancel" && req.method === "POST") return send(res, 200, await adView(service, ctx, await service.cancelAd(ctx, id)));
        if (id && action === "approve" && req.method === "POST") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string") throw new AdError("invalid_input", "Idempotency-Key header is required.");
          const body = ApproveBody.safeParse(await readJson(req, maxBody));
          if (!body.success) throw new AdError("invalid_input", body.error.message);
          const ad = await service.approveAndRender(ctx, id, { ...body.data, idempotency_key: key });
          return send(res, 202, await adView(service, ctx, ad));
        }
      }
      const kitMatch = path.match(/^\/v1\/brand-kits\/([^/]+)$/);
      if (kitMatch && req.method === "GET") return send(res, 200, envelope(await service.getBrandKit(ctx, kitMatch[1])));
      const dl = path.match(/^\/v1\/renders\/([^/]+)\/download-url$/);
      if (dl && req.method === "GET") return send(res, 200, envelope(await service.downloadUrl(ctx, dl[1])));
      const rules = path.match(/^\/v1\/brand-kits\/([^/]+)\/rules$/);
      if (rules && req.method === "PUT") {
        const body = RulesBody.safeParse(await readJson(req, maxBody));
        if (!body.success) throw new AdError("invalid_input", body.error.message);
        return send(res, 200, envelope(await service.setBrandRules(ctx, rules[1], body.data)));
      }
      send(res, 404, envelope({ error: { code: "not_found", message: "Not found" } }));
    } catch (err) {
      if (err instanceof AdError) {
        const extra: Record<string, string> = err.retry_after ? { "retry-after": String(Math.ceil(err.retry_after)) } : {};
        if (err.code === "unauthorized") extra["www-authenticate"] = challenge(req, err.message);
        return send(res, HTTP_STATUS[err.code], envelope({ error: { code: err.code, message: err.message, retry_after: err.retry_after ?? null } }), extra);
      }
      log.error("unhandled", { request_id: requestId, error: err });
      send(res, 500, envelope({ error: { code: "provider_unavailable", message: "Unexpected server error." } }));
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  return server;
}
