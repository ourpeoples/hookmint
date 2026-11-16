# Hookmint: conventions for AI sessions

MCP server and REST API that turn a prompt into a video ad, check it against brand rules, and (later) learn which
ideas win. Design doc: `docs/DESIGN.md` (snapshot of the live design doc). Read it before large changes.

## Commands
- `npm test` runs smoke, foundations, brand, variants and the tool-contract snapshot. `npm run typecheck` must also pass.
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
- **No secrets** in the repo, logs, tool results or test fixtures.

## Status and limits
Providers are stubs (no paid APIs). State is in memory behind `MemoryStore`; Postgres with row-level security comes later.
Credit costs in `src/core/costs.ts` are placeholders, not real provider prices.
