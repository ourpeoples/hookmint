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

It writes one script, two hook variants and one semantic check, prints the writing for you to judge, and asserts only structure.

## Run

```bash
npm install
npm test            # in-memory client drives the full lifecycle
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

## Tools (v0.5.0)

`create_brand_kit`, `set_brand_rules`, `create_ad`, `get_ad_status`, `check_ad`, `estimate_cost`, `get_storyboard`,
`create_variants`, `update_script`, `regenerate_scene`, `approve_and_render`, `cancel_ad`, `list_ads`.

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
- `src/brand/` rule types, deterministic checker, semantic-finding validator
- `src/core/` schemas, service layer and state machine, store, provider-call dedupe, costs, errors, scopes
- `src/providers/` provider interfaces and stubs
- `src/server/` MCP tools, REST and MCP HTTP app, result views
- `tests/` smoke, foundations, and `contract/` tool-schema snapshot (`npm run test:update-snapshot` after an intended change)

## Not yet built (see design doc)

Real script provider (needs an Anthropic API key), Postgres with row-level security, OAuth 2.1, semantic (model) checker,
real variant generation, rendering, ad-platform feedback loop, Claude Code plugin packaging.
