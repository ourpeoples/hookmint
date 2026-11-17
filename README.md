# Hookmint

MCP server that turns a prompt into a video ad, checks it against your brand rules, and learns which ideas win.

Status: the job state machine, idempotency, credit reservations, brand rules, variants and the REST/MCP layers work end to
end. Script writing, variant writing and the semantic brand check can use **Claude** when a key is set; visuals, voice and
rendering are still **stubs** (no real video yet).

Design doc: "Hookmint: Technical Design".

## Using Claude

Set `ANTHROPIC_API_KEY` and Hookmint uses Claude for the script, the variants and the semantic brand check. Without it,
everything runs on stubs. Put the key in a gitignored `.env`, or as a secret variable on the host. Never commit it.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns on the Claude providers |
| `HOOKMINT_MODEL` | `claude-sonnet-5-5` | Script and variants |
| `HOOKMINT_SEMANTIC_MODEL` | `claude-haiku-5-5` | Semantic brand check |
| `HOOKMINT_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Gateway or proxy. `ANTHROPIC_BASE_URL` is deliberately ignored |

The Claude code is tested offline against a fake HTTP layer. To try it for real (spends a few cents):

```bash
ANTHROPIC_API_KEY=... npm run test:live
```

`test:live` also reads a `.env` file in the project folder if there is one (it is git-ignored), so you can put
`ANTHROPIC_API_KEY=your-key` in `.env` and just run `npm run test:live`.

It writes one script, two hook variants and one semantic check, prints the writing for you to judge, and asserts only structure.

## Rendering

By default rendering is a stub that returns a placeholder link. Set `HOOKMINT_RENDERER=remotion` to make real MP4s with
[Remotion](https://www.remotion.dev): your brand colour, the script's on-screen text and captions, and a call-to-action button,
in 9:16, 1:1 and 16:9, kept inside each shape's safe area. Real stock footage and voiceover do not exist yet, so scenes use a brand
gradient and the video is silent unless local media is supplied. The render notes in `get_ad_status` say exactly what was missing.

| Variable | Default | Purpose |
|---|---|---|
| `HOOKMINT_RENDERER` | stub | `remotion` for real MP4 files |
| `HOOKMINT_BROWSER` | auto-detected | Path to Chrome or Chromium. Needed on the host |
| `HOOKMINT_DATA_DIR` | `./data` | Finished videos go in `renders/`; local media is read only from `assets/` |
| `HOOKMINT_URL_SECRET` | random per run | 32+ characters. Signs download links. Set it, or links die when the server restarts |
| `HOOKMINT_PUBLIC_URL` | `http://localhost:<port>` | Base of download links |
| `HOOKMINT_DOWNLOAD_TTL_S` | `900` | Link lifetime, 60 to 3600 seconds |
| `HOOKMINT_RENDER_CONCURRENCY` | `1` | Renders at once. Each drives a browser |

Download links are signed and expire (about 15 minutes). `get_ad_status` returns fresh ones, and `get_download_url` mints another
when one has expired. Downloads need the HTTP entry (`npm run dev:http`); the stdio entry shows local file paths instead.
Each MP4 carries a provenance tag stating it is AI-generated, with the ad, plan, hook and the template actually used.

**Remotion licence.** Remotion is free for individuals and for-profit companies with up to 3 employees, and for non-profits.
Larger for-profit companies need a paid company licence. Read `node_modules/remotion/LICENSE.md` and confirm you are eligible
before running this as a business.

## Logos and remote media

Give `create_brand_kit` a `logo_url` and Hookmint downloads it in the background (`get_brand_kit` shows `logo_status`:
`pending`, `ready`, `failed` or `unavailable`). The logo appears on a white chip at the top left of each video. Remote
scene stills, clips and voiceovers from providers are downloaded the same way before rendering. This needs
`HOOKMINT_RENDERER=remotion`, which provides the asset folder.

Every download goes through one hardened fetcher, because the address comes from a user or a provider:

- https only, standard port, no credentials in the address; private, loopback, link-local (including the cloud metadata
  address), shared and reserved addresses are refused, in IPv4 and IPv6 and in every spelling of them.
- The name is looked up once, every answer must be public, and the connection goes to that exact address, so DNS cannot
  switch to an internal address between the check and the connection. Every redirect is checked again from scratch.
- Time, size and file-type limits; compressed downloads refused; no cookies or credentials sent; no proxy used.
- Images are decoded and re-encoded (PNG, JPEG and WebP only; SVG, GIF and animated files are refused), which removes
  metadata and anything hidden in the file. Audio and video are checked with ffprobe using a forced file format and a
  file-only protocol whitelist. Files are stored under names the server chooses, never names taken from a URL.

A download that fails never fails the ad: that scene falls back to the brand gradient and the render notes say why.

## Limits

Per-account limits keep cost, abuse and fairness in check. Over a limit, a tool returns `[rate_limited]` with a plain message and
`retry_after` seconds; REST returns `429` with a `Retry-After` header. Repeating an earlier request with the same `idempotency_key`
is free and never counts. Defaults (set `HOOKMINT_LIMITS` to a JSON object to change any of them; a mistake stops startup):

| Setting | Default | What it limits |
|---|---|---|
| `requestsPerMinute` | 300 | Any tool call or REST request |
| `createAdPerHour` | 20 | New ads |
| `createVariantsPerHour` | 20 | Variants, counted by how many were asked for |
| `createBrandKitPerHour` | 20 | New brand kits |
| `setBrandRulesPerHour` | 60 | Rule changes |
| `spendActionsPerHour` | 60 | Approvals and confirmed scene regenerations |
| `maxActiveJobs` | 3 | Videos being made at once, per account |
| `maxPendingLogos` | 5 | Logos still downloading, per account |
| `fetchesPerDay` | 300 | Downloads the server makes for an account |
| `fetchBytesPerDay` | 1 GiB | Download size per account per day |
| `authFailuresPer10Min` | 30 | Bad API keys or bad download links from one address |

Failed-credential limits only ever refuse requests that already failed, so a valid key or download link is never locked out by
someone else's guessing. Counters are in memory: with more than one server instance each counts separately until they share a
store. These are starting values; tune them with real use.

## Run

```bash
npm install
npm test            # fast suites: lifecycle, brand, variants, Claude (offline), tool contract
npm run test:render # slow: renders real videos in a real browser (about 2.5 minutes)
npm run dev         # stdio transport
PORT=3000 npm run dev:http   # Streamable HTTP at http://localhost:3000/mcp (optional API_KEY bearer check)
```

## Connect a client

Claude Code (stdio):

```bash
claude mcp add hookmint -- npx tsx /absolute/path/to/hookmint/src/index.ts
```

Claude Code (HTTP): `claude mcp add --transport http hookmint http://localhost:3000/mcp`

Cursor / others (`mcp.json`):

```json
{ "mcpServers": { "hookmint": { "command": "npx", "args": ["tsx", "/absolute/path/to/hookmint/src/index.ts"] } } }
```

ChatGPT and Claude.ai need a public HTTPS URL plus OAuth (milestone 5).

## Tools (v0.8.0)

`create_brand_kit`, `get_brand_kit`, `set_brand_rules`, `create_ad`, `get_ad_status`, `check_ad`, `estimate_cost`, `get_storyboard`,
`create_variants`, `get_download_url`, `update_script`, `regenerate_scene`, `approve_and_render`, `cancel_ad`, `list_ads`.

Flow: `set_brand_rules` (once per brand) -> `create_ad` -> poll `get_ad_status` until `awaiting_approval` -> `check_ad` / `get_storyboard` / `estimate_cost` (free) ->
optional `update_script` -> `approve_and_render` with `max_credits` -> poll until `completed`.

Rules every client should know:
- Spending tools take an `idempotency_key`; repeating a call with the same key and inputs returns the original job.
- `approve_and_render` and `regenerate_scene` need `max_credits`; `regenerate_scene` only estimates unless `confirm: true`.
- Variants: `create_variants` makes 1 to 5 alternatives that differ in exactly one of `hook`, `angle`, `offer`, `cta`, `visual_style`. A deterministic diff engine rejects any variant that changes anything else, or is too close to the base or to another variant. Variants are normal ads: estimate, check, then approve each one.
- Brand rules: `forbidden_claim` and `required_disclaimer` block approval by default (`blocked_by_rule`); pass `override_reason` to proceed, which is audited. Findings are advisory, not legal advice.
- Every result has `schema_version` and `warnings[]`. Errors are tool results with `isError` and a code such as `[conflict]`.

## REST (same service layer)

`POST /v1/ads` (header `Idempotency-Key`), `GET /v1/ads`, `GET /v1/ads/:id`, `GET /v1/ads/:id/estimate`,
`GET /v1/ads/:id/storyboard`, `GET /v1/ads/:id/check`, `POST /v1/ads/:id/variants` (header `Idempotency-Key`, body `{count, tested_variable}`), `PUT /v1/brand-kits/:id/rules`, `POST /v1/ads/:id/approve` (header `Idempotency-Key`, body `{max_credits}`), `POST /v1/ads/:id/cancel`.
Set `API_KEY` to require `Authorization: Bearer <key>`.

## Layout

- `src/variants/` diff engine: field sets per tested variable, near-duplicate measure
- `src/net/` the hardened fetcher, address rules, image sanitiser and media ingestor
- `src/render/` shared layout rules (`layout.ts`), local-asset resolver and server, Remotion renderer
- `render/` the Remotion video template (React) and bundled Inter font (SIL OFL)
- `src/brand/` rule types, deterministic checker, semantic-finding validator
- `src/core/` schemas, service layer and state machine, store, provider-call dedupe, costs, errors, scopes
- `src/providers/` provider interfaces and stubs
- `src/server/` MCP tools, REST and MCP HTTP app, result views
- `tests/` smoke, foundations, and `contract/` tool-schema snapshot (`npm run test:update-snapshot` after an intended change)

## Not yet built (see design doc)

Real script provider (needs an Anthropic API key), Postgres with row-level security, OAuth 2.1, semantic (model) checker,
real variant generation, rendering, ad-platform feedback loop, Claude Code plugin packaging.

## Running it for real (v0.9)

Everything below is controlled by environment variables. `HOOKMINT_ENV=production` turns on startup checks: the server refuses to start without hashed API keys, a stable `HOOKMINT_URL_SECRET` (32+ characters), and an explicit `HOOKMINT_ALLOW_EPHEMERAL=1` while state is still in memory.

| Variable | What it does |
| --- | --- |
| `HOOKMINT_API_KEYS_FILE` | JSON array of key records (digest only, optional scopes, expiry, revocation). Make one with `npm run keys:new -- --account acct_x --expires 2027-06-30`. Rotate by adding a new key, moving clients, then setting `revoked_at` on the old one. |
| `API_KEY` | One plaintext key, development only. Refused in production. |
| `HOOKMINT_CORS_ORIGINS` | Comma-separated exact origins allowed to call from a browser. Empty means none. `*` is refused. |
| `HOOKMINT_MAX_BODY_BYTES` | Largest request body (default 1 MiB). Larger gets 413; a non-JSON body gets 415. |
| `HOOKMINT_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. One JSON object per line on stderr; secrets are redacted and query strings are never logged. |
| `HOOKMINT_HSTS` | `1` to send Strict-Transport-Security when only served over HTTPS. |
| `HOOKMINT_SHUTDOWN_GRACE_MS` | How long SIGTERM waits for in-flight requests (default 25000). |

`GET /healthz` is liveness. `GET /readyz` is readiness and reports `draining` (503) during shutdown, whether state is durable (`store`), and any provider whose circuit breaker is open. Every response carries `x-request-id`. Provider calls have a deadline (default 120 s) and a per-provider circuit breaker (5 failures, 30 s pause).

`npm run lint`, `npm run typecheck`, `npm test`, `npm run audit` and `npm run build` run in CI; the slow render tests run as a separate parallel job.
