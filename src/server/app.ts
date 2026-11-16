import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fullAccess, type Ctx } from "../core/context.js";
import { AdError, HTTP_STATUS } from "../core/errors.js";
import { AspectRatio } from "../core/schemas.js";
import type { AdService } from "../core/service.js";
import { z } from "zod";
import { buildMcpServer } from "./mcp.js";
import { adView, envelope } from "./views.js";

export interface AppOptions {
  /** Bearer API key -> context. Placeholder for OAuth 2.1 (milestone 6). No keys configured = open (local dev only). */
  apiKeys?: Map<string, Ctx>;
  devCtx?: Ctx;
}

const CreateBody = z.object({
  prompt: z.string().min(10),
  brand_kit_id: z.string().optional(),
  duration_s: z.number().int().min(6).max(60).default(15),
  aspect_ratios: z.array(AspectRatio).min(1).default(["9:16"]),
});
const ApproveBody = z.object({ max_credits: z.number().int().min(0) });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AdError("invalid_input", "Request body is not valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function createApp(service: AdService, opts: AppOptions = {}): Server {
  const authenticate = (req: IncomingMessage): Ctx => {
    if (!opts.apiKeys || opts.apiKeys.size === 0) return opts.devCtx ?? fullAccess("acct_dev");
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const ctx = token ? opts.apiKeys.get(token) : undefined;
    if (!ctx) throw new AdError("forbidden", "Missing or invalid API key.");
    return ctx;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const ctx = authenticate(req);

      // ---- MCP over Streamable HTTP (stateless transport per request) ----
      if (path === "/mcp") {
        if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
        const body = await readJson(req);
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
      const m = path.match(/^\/v1\/ads(?:\/([^/]+))?(?:\/(estimate|approve|cancel|storyboard))?$/);
      if (m) {
        const [, id, action] = m;
        if (!id && req.method === "POST") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string") throw new AdError("invalid_input", "Idempotency-Key header is required.");
          const body = CreateBody.safeParse(await readJson(req));
          if (!body.success) throw new AdError("invalid_input", body.error.message);
          const ad = service.createAd(ctx, { ...body.data, idempotency_key: key });
          return send(res, 201, adView(service, ctx, ad));
        }
        if (!id && req.method === "GET") {
          const ads = service.listAds(ctx, 20).map((a) => ({ job_id: a.id, status: a.status, created_at: a.created_at }));
          return send(res, 200, envelope({ ads }));
        }
        if (id && !action && req.method === "GET") return send(res, 200, adView(service, ctx, service.getAd(ctx, id)));
        if (id && action === "estimate" && req.method === "GET") return send(res, 200, envelope(service.estimateCost(ctx, id)));
        if (id && action === "storyboard" && req.method === "GET") return send(res, 200, envelope(service.getStoryboard(ctx, id)));
        if (id && action === "cancel" && req.method === "POST") return send(res, 200, adView(service, ctx, service.cancelAd(ctx, id)));
        if (id && action === "approve" && req.method === "POST") {
          const key = req.headers["idempotency-key"];
          if (typeof key !== "string") throw new AdError("invalid_input", "Idempotency-Key header is required.");
          const body = ApproveBody.safeParse(await readJson(req));
          if (!body.success) throw new AdError("invalid_input", body.error.message);
          const ad = service.approveAndRender(ctx, id, { ...body.data, idempotency_key: key });
          return send(res, 202, adView(service, ctx, ad));
        }
      }
      send(res, 404, envelope({ error: { code: "not_found", message: "Not found" } }));
    } catch (err) {
      if (err instanceof AdError) {
        return send(res, HTTP_STATUS[err.code], envelope({ error: { code: err.code, message: err.message, retry_after: err.retry_after ?? null } }));
      }
      console.error(err);
      send(res, 500, envelope({ error: { code: "provider_unavailable", message: "Unexpected server error." } }));
    }
  });
}
