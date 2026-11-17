import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Ctx } from "../core/context.js";
import { AdError } from "../core/errors.js";
import { ExampleInput, RuleInput } from "../brand/rules.js";
import { AspectRatio } from "../core/schemas.js";
import { TESTED_VARIABLES } from "../variants/diff.js";
import type { AdService } from "../core/service.js";
import { adView, envelope } from "./views.js";

function ok(summary: string, data: object): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(err: unknown): CallToolResult {
  const e = err instanceof AdError ? err : new AdError("provider_unavailable", "Unexpected server error.");
  if (!(err instanceof AdError)) console.error(err);
  const body = envelope({ error: { code: e.code, message: e.message, retry_after: e.retry_after ?? null } });
  return { isError: true, content: [{ type: "text", text: `[${e.code}] ${e.message}\n\n${JSON.stringify(body, null, 2)}` }] };
}

const guardedBase =
  <A>(fn: (args: A) => CallToolResult | Promise<CallToolResult>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe("Unique string for this request, e.g. a UUID. Repeating a call with the same key and inputs returns the original result and spends nothing extra.");

export function buildMcpServer(service: AdService, ctx: Ctx): McpServer {
  const server = new McpServer({ name: "hookmint", version: "0.13.2" });
  // Every tool call counts against the account's per-minute allowance before it does anything.
  const guarded = <A>(fn: (args: A) => CallToolResult | Promise<CallToolResult>) => guardedBase<A>((args) => { service.admit(ctx); return fn(args); });

  server.registerTool(
    "create_brand_kit",
    {
      title: "Create brand kit",
      description:
        "Save a reusable brand kit (logo, colors, font, tone). Returns brand_kit_id to pass to create_ad. Call this once per brand, before create_ad.",
      inputSchema: {
        name: z.string().describe("Brand or company name"),
        logo_url: z.string().url().optional().describe("Public https URL of a PNG, JPEG or WebP logo (SVG is not accepted). It is downloaded in the background; check logo_status with get_brand_kit"),
        colors: z.array(z.string()).default([]).describe("Brand colors as hex codes, primary first"),
        font: z.string().optional().describe("Font family name"),
        tone: z.string().optional().describe("Voice and tone, e.g. 'friendly, trustworthy'"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const kit = await service.createBrandKit(ctx, args);
      return ok(`Created brand kit ${kit.id}${kit.logo_status === "pending" ? "; its logo is downloading" : ""}.`, envelope({ brand_kit_id: kit.id, logo_status: kit.logo_status }));
    }),
  );

  server.registerTool(
    "get_brand_kit",
    {
      title: "Get brand kit",
      description:
        "Get a brand kit's details, including logo_status: 'none' (no logo given), 'pending' (still downloading), 'ready', 'failed' (logo_error says why) or 'unavailable' (this server cannot download logos). Read-only.",
      inputSchema: { brand_kit_id: z.string().describe("From create_brand_kit") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ brand_kit_id }) => {
      const kit = await service.getBrandKit(ctx, brand_kit_id);
      return ok(`${kit.name}: logo ${kit.logo_status}.`, envelope(kit));
    }),
  );

  server.registerTool(
    "set_brand_rules",
    {
      title: "Set brand rules",
      description:
        "Replace a brand kit's rules. Rule types: banned_phrase, regex, forbidden_claim and required_disclaimer are checked deterministically; semantic rules are plain-language instructions checked by a model (advisory only). Each call saves a new rule-set version. forbidden_claim and required_disclaimer block approval by default. Examples (tone, past winners) guide generation and never block.",
      inputSchema: {
        brand_kit_id: z.string().describe("From create_brand_kit"),
        rules: z.array(RuleInput).max(200),
        examples: z.array(ExampleInput).max(50).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ brand_kit_id, ...rest }) => {
      const r = await service.setBrandRules(ctx, brand_kit_id, rest);
      return ok(`Saved ${r.rule_count} rule(s) as version ${r.version}.`, envelope(r));
    }),
  );

  server.registerTool(
    "check_ad",
    {
      title: "Check ad against brand rules",
      description:
        "Check the ad's current script against its brand kit's rules and return findings (severity, rule, quoted text, suggested fix). Free and read-only. Rules with type \"semantic\" are checked by a model in the background: semantic_status is \"pending\" until it finishes, \"off\" if no model is configured, \"unavailable\" if it failed. Findings are advisory, not legal advice. A 'block' finding stops approve_and_render unless an override_reason is given.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ job_id }) => {
      const r = await service.checkAd(ctx, job_id);
      return ok(`Check: ${r.status} (${r.counts.block} block, ${r.counts.warn} warn, ${r.counts.info} info).`, envelope(r));
    }),
  );

  server.registerTool(
    "create_ad",
    {
      title: "Create video ad",
      description:
        "Start a new video ad from a text prompt. Writes the script only (no paid generation) and returns a job_id. Next: poll get_ad_status until status is 'awaiting_approval', review the plan, call estimate_cost, optionally edit the script, then call approve_and_render.",
      inputSchema: {
        prompt: z.string().min(10).describe("What the ad is for: product, audience, offer, desired feel"),
        brand_kit_id: z.string().optional().describe("From create_brand_kit"),
        duration_s: z.number().int().min(6).max(60).default(15).describe("Ad length in seconds"),
        aspect_ratios: z.array(AspectRatio).min(1).default(["9:16"]).describe("Output formats to render"),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const ad = await service.createAd(ctx, args);
      return ok(`Started ${ad.id}. Poll get_ad_status; the script takes a few seconds.`, await adView(service, ctx, ad));
    }),
  );

  server.registerTool(
    "get_ad_status",
    {
      title: "Get ad status",
      description:
        "Get a job's status, progress, current script (scene plan), scene previews, final render URLs and your credit balance. Read-only; safe to poll every few seconds.",
      inputSchema: { job_id: z.string().describe("From create_ad") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ job_id }) => {
      const ad = await service.getAd(ctx, job_id);
      return ok(`${ad.id} is ${ad.status} (${service.progress(ad)}%).`, await adView(service, ctx, ad));
    }),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate cost",
      description:
        "Show what approve_and_render would cost in credits, broken down by stage, plus your available balance. Free and read-only. Call before approve_and_render and pass the number as max_credits.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ job_id }) => {
      const e = await service.estimateCost(ctx, job_id);
      return ok(`Approving would cost ${e.credits} credits (${e.balance.available} available).`, envelope(e));
    }),
  );

  server.registerTool(
    "get_storyboard",
    {
      title: "Get storyboard",
      description:
        "Get a free preview of the ad's timing and captions, scene by scene, before any paid generation. Read-only.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ job_id }) => {
      const s = await service.getStoryboard(ctx, job_id);
      return ok(`Storyboard for plan version ${s.plan_version}, ${s.total_s}s total.`, envelope(s));
    }),
  );

  server.registerTool(
    "update_script",
    {
      title: "Edit script",
      description:
        "Edit the hook, call to action, or individual scenes of the script. Only works while status is 'awaiting_approval'. Free. Total scene duration must stay within 1 second of the requested ad length. Each edit creates a new plan version.",
      inputSchema: {
        job_id: z.string(),
        hook: z.string().optional(),
        cta_text: z.string().optional(),
        scenes: z
          .array(
            z.object({
              scene_id: z.string(),
              voiceover: z.string().optional(),
              on_screen_text: z.string().optional(),
              visual_prompt: z.string().optional(),
              duration_s: z.number().min(1).max(10).optional(),
            }),
          )
          .optional()
          .describe("Only the scenes you want to change"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ job_id, ...edits }) => {
      const ad = await service.updateScript(ctx, job_id, edits);
      return ok(`Script updated to version ${ad.plans.length}.`, await adView(service, ctx, ad));
    }),
  );

  server.registerTool(
    "regenerate_scene",
    {
      title: "Regenerate scene",
      description:
        "Re-create the visual and voiceover for one scene using an instruction (e.g. 'show a family instead'). SPENDS CREDITS. Without confirm=true it only returns the estimate. To run it, pass confirm=true and max_credits. Only works while status is 'awaiting_approval'; the job returns to that status when done. Each ad allows a limited number of regenerations.",
      inputSchema: {
        job_id: z.string(),
        scene_id: z.string(),
        instruction: z.string().min(3).describe("What to change about this scene"),
        confirm: z.boolean().default(false).describe("Must be true to spend credits"),
        max_credits: z.number().int().min(0).optional().describe("Refuse if the estimate is higher than this"),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const { job_id, ...rest } = args;
      const r = await service.regenerateScene(ctx, job_id, rest);
      const msg = r.started
        ? `Regenerating ${args.scene_id} for ${r.estimate.credits} credits. Poll get_ad_status.`
        : `Estimate: ${r.estimate.credits} credits. Nothing was spent. Call again with confirm=true and max_credits to run it.`;
      return ok(msg, { ...await adView(service, ctx, r.ad), estimate: r.estimate, started: r.started });
    }),
  );

  server.registerTool(
    "approve_and_render",
    {
      title: "Approve and render",
      description:
        "Approve the current script and start paid generation and the final render for every requested aspect ratio. SPENDS CREDITS: pass max_credits (use the number from estimate_cost); the call is refused if the estimate is higher. Refused with blocked_by_rule if check_ad shows blocking findings, unless override_reason is given. Only works while status is 'awaiting_approval'. Poll get_ad_status until 'completed' to get the video URLs.",
      inputSchema: {
        job_id: z.string(),
        max_credits: z.number().int().min(0).describe("Maximum credits you allow this to cost"),
        override_reason: z.string().min(10).max(500).optional().describe("Only if check_ad shows 'block' findings you accept. Recorded in the audit log."),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async ({ job_id, ...rest }) => {
      const ad = await service.approveAndRender(ctx, job_id, rest);
      return ok(`Rendering ${ad.id}. Poll get_ad_status.`, await adView(service, ctx, ad));
    }),
  );

  server.registerTool(
    "create_variants",
    {
      title: "Create variants",
      description:
        "Create 1 to 5 alternative versions of an ad that differ from it in exactly one thing: hook, angle, offer, cta or visual_style. Every variant is checked by a deterministic diff against the base ad and rejected if it changes anything else, so results from a later test can be attributed to that one variable. Returns each variant's job_id, the computed diff, and its brand-rule check. Free (text only); the variants then go through the normal estimate_cost, check_ad and approve_and_render steps. Works on an ad that is 'awaiting_approval' or 'completed'. One variant group tests one variable.",
      inputSchema: {
        job_id: z.string().describe("The base ad"),
        count: z.number().int().min(1).max(5).describe("How many variants to create"),
        tested_variable: z.enum(TESTED_VARIABLES).describe("The one thing that should differ"),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ job_id, ...rest }) => {
      const r = await service.createVariants(ctx, job_id, rest);
      const data = envelope({
        variant_group_id: r.variant_group_id,
        tested_variable: r.tested_variable,
        base_job_id: r.base_ad_id,
        variants: r.variants.map((v) => ({
          job_id: v.ad.id,
          status: v.ad.status,
          hook_id: v.ad.plans[0].hook_id,
          angle: v.ad.plans[0].angle,
          diff: v.diff,
          check: v.check,
        })),
      });
      return ok(`Created ${r.variants.length} variant(s) testing "${r.tested_variable}" in group ${r.variant_group_id}.`, data);
    }),
  );

  server.registerTool(
    "cancel_ad",
    {
      title: "Cancel ad",
      description:
        "Cancel a job that has not finished. Credits held for stages that have not run are released. Safe to repeat.",
      inputSchema: { job_id: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    guarded(async ({ job_id }) => {
      const ad = await service.cancelAd(ctx, job_id);
      return ok(`${ad.id} is ${ad.status}.`, await adView(service, ctx, ad));
    }),
  );

  server.registerTool(
    "get_download_url",
    {
      title: "Get download link",
      description:
        "Get a fresh download link for a finished video, using a render_id from get_ad_status. Links expire after about 15 minutes, so call this again whenever you need one. Read-only.",
      inputSchema: { render_id: z.string().describe("From the renders list in get_ad_status") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ render_id }) => {
      const r = await service.downloadUrl(ctx, render_id);
      return ok(`Link for ${r.render_id}, valid for ${Math.round(r.ttl_s / 60)} minutes.`, envelope(r));
    }),
  );

  server.registerTool(
    "list_ads",
    {
      title: "List ads",
      description: "List recent ads and their statuses, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ limit }) => {
      const ads = (await service.listAds(ctx, limit)).map((a) => ({
        job_id: a.id,
        status: a.status,
        prompt: a.prompt,
        variant_of: a.variant_of ?? null,
        variant_group_id: a.plans.at(-1)?.variant_group_id ?? null,
        created_at: a.created_at,
      }));
      return ok(`${ads.length} ad(s).`, envelope({ ads }));
    }),
  );

  return server;
}
