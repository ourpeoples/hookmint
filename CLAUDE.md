# Hookmint: conventions for AI sessions

MCP server and REST API that turn a prompt into a video ad, check it against brand rules, and (later) learn which
ideas win. Design doc: `docs/DESIGN.md` (snapshot of the live design doc). Read it before large changes.

## Commands
- `npm test` runs smoke, foundations, brand, variants, claude (offline), net (downloads, images, logos), limits and the tool-contract snapshot. `npm run test:render` (about 2.5 minutes, needs Chrome) renders real videos; run it after touching `render/` or `src/render/`. `npm run typecheck` checks both projects and must pass.
- `npm run test:update-snapshot` rewrites `tests/contract/tools.snapshot.json`. Only run it for an intended tool change.

## Rules that must not be broken
- **One service layer.** MCP tools (`src/server/mcp.ts`) and REST (`src/server/app.ts`) call `AdService` and hold no business logic.
- **Tool names are stable.** Never rename or remove a tool or input field without a deliberate version decision and a snapshot update.
- **Spending tools** take `idempotency_key` and `max_credits`. Spend goes through reservations; never write the ledger directly.
- **State changes** go through `transition()` (version-checked). Handlers must ignore stale or repeated deliveries.
- **Provider calls** go through `providerCalls.runOnce(key, ...)` so a retry never pays twice.
- **Every query is account-scoped.** Use `requireAd` and the context's `accountId`; add a cross-tenant test for new data.
- **Scopes:** check with `requireScope` in the service method, not in the transport.
- **Brand rules are deterministic first.** An LLM check may only add warnings that cite a rule ID and a verbatim quote. It never blocks.
- **Variants are proven, not trusted.** A provider only proposes plans. `checkVariant` (src/variants/diff.ts) decides, computes the stored diff, and ids and the template come from the server. Never store a provider-supplied `diff`, `hook_id` or `variant_group_id`.
- **Identifiers are not content.** Exclude ids from any text-similarity measure.
- **Provider-call keys** must include the request's idempotency key, so a retry reuses a result and a new request never does.
- **Claude calls go through `ClaudeClient.callTool` only.** The system prompt is a fixed constant; customer text (prompts, brand rules, ad text) goes only in the user message as JSON data. Offer one forced tool, validate the answer with Zod, and never give the model tools that act. Error messages carry status and request id only: never the key or the request body.
- **Model output is untrusted.** The service mints ids; the diff engine proves variants; semantic findings must cite a rule and quote the plan verbatim and are capped at warn. A model failure must degrade (`semantic_status: "unavailable"`), never fail an ad or block approval.
- **Never read `ANTHROPIC_BASE_URL`.** Other tools set it for their own gateways. Use `HOOKMINT_ANTHROPIC_BASE_URL`.
- **The renderer never fetches a URL.** It reads only local files under its asset folder (`resolveLocalAsset`: realpath, folder check, extension and role allow-list) and serves them through random single-file tokens. Remote media is downloaded first by `MediaIngestor` into that folder.
- **Every request for a user- or provider-supplied URL goes through `SafeFetcher`.** Never call `fetch` or `https` directly for such a URL, never read proxy settings for it, and never loosen its checks. It resolves once, requires every address to be public, and connects to that validated address. `allowPrivateNetworks` exists for tests only and must never come from configuration.
- **Untrusted media is rebuilt, not trusted.** Images go through `sanitizeImage` (allow-list PNG, JPEG, WebP; never SVG; always re-encoded). Audio and video are checked with ffprobe with a forced demuxer and `-protocol_whitelist file`. Stored names are chosen by the server.
- **Local file paths are never shown to clients.** Previews show web addresses only.
- **Only plain hex reaches the template's CSS** (`sanitizeColor`). Text is rendered as React text, never HTML.
- **Everything readable stays inside the safe area** (`SAFE_ZONES` in `src/render/layout.ts`; the container clips overflow). Layout rules live in that pure module and are unit-tested; change them there, not in the template. `pickTextColor` uses pure black because near-black fails 4.5:1 on mid-tones.
- **Download links are signed on read, never stored.** A link names one render and one account and expires. The `/files` route is authorised by the signature alone, so it must verify before it touches the disk.
- **Pin Remotion exactly, and keep every `@remotion/*` package at the same version.** Check the licence terms before changing how it is used.
- **Anything that spends money, calls a model, or makes the server fetch is limit-checked in the service, before the work starts** (`src/core/limits.ts`). A replay of an idempotent request must never count, and a refused request must do nothing. Our own limits are final: build them with `{ retry: false }` so the provider-retry logic never retries them. Failed-credential limits count only failures, so valid users are never locked out.
- **No secrets** in the repo, logs, tool results or test fixtures.

## Status and limits
Script, variants and the semantic check use Claude when `ANTHROPIC_API_KEY` is set; they are tested offline only, and `npm run test:live` is how a person verifies them for real. Visuals and voice providers are stubs (downloading their remote media is built). Rendering is a stub unless `HOOKMINT_RENDERER=remotion`, which makes real MP4s from text, captions, brand colour and a call to action (no real footage or voiceover yet). State is in memory behind `MemoryStore`; Postgres with row-level security comes later.
Credit costs in `src/core/costs.ts` are placeholders, not real provider prices.
