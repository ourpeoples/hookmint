# Hookmint: conventions for AI sessions

MCP server and REST API that turn a prompt into a video ad, check it against brand rules, and (later) learn which
ideas win. Design doc: `docs/DESIGN.md` (snapshot of the live design doc). Read it before large changes.

## Commands
- `npm test` runs smoke, foundations, brand, variants, claude (offline) and the tool-contract snapshot. `npm run typecheck` must also pass.
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
- **No secrets** in the repo, logs, tool results or test fixtures.

## Status and limits
Script, variants and the semantic check use Claude when `ANTHROPIC_API_KEY` is set; they are tested offline only, and `npm run test:live` is how a person verifies them for real. Visuals, voice and rendering are stubs. State is in memory behind `MemoryStore`; Postgres with row-level security comes later.
Credit costs in `src/core/costs.ts` are placeholders, not real provider prices.
