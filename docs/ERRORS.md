# Errors

Every failed call returns an `error` object: `code`, a plain-language `message`, `retry_after` (seconds, or null),
`retryable`, and for rate limits `limit`. Over MCP the same object is in the tool result with `isError: true`. Over REST
it is the response body, with the HTTP status shown below. When the server has `HOOKMINT_DOCS_URL` set, each error also
carries `docs_url` pointing at its section here.

`retryable: true` means trying the same call again later can work. `retryable: false` means it will fail the same way until
something changes, so do not loop on it.

## invalid_input
HTTP 400. The request is wrong: a missing or malformed field, a value out of range, a download address that is not allowed,
or a model answer that broke the format. Read `message`, fix the input, and send a new request. Not retryable.

## unauthorized
HTTP 401. No credentials, or credentials that are wrong, expired or revoked (an API key or an OAuth token). The response has
a `WWW-Authenticate` header; for OAuth it points to the discovery document. Get a fresh key or token. Repeated failures from
one network address are slowed down. Not retryable until the credentials change.

## forbidden
HTTP 403. The credentials are valid but not allowed to do this: a missing scope (the message names it), or a sign-in that is
not linked to a Hookmint account. Ask the account owner for the scope or the invitation. Not retryable.

## not_found
HTTP 404. No such item in your account. Ids from another account look exactly the same as ids that do not exist. Check the
id, and that you are using the right account. Not retryable.

## conflict
HTTP 409. The item is in the wrong state for this call (for example approving an ad that is not awaiting approval), the
`idempotency_key` was already used for a different request, or someone else changed it at the same moment. Read the
message, re-read the item, then decide. A "changed by another request" conflict is retryable; the others are not.

## insufficient_credits
HTTP 402. The account does not have enough available credits for this action. Call `estimate_cost` to see the price and
`get_ad_status` for the balance. Not retryable until credits are added.

## rate_limited
HTTP 429. Check `limit`:
- `"account"`: one of Hookmint's own allowances (new ads per hour, paid actions per hour, downloads per day, and so on).
  `retry_after` says when there is room again. `retryable` is false: retrying sooner only fails again. Wait, or ask for a
  higher limit.
- `"provider"`: an outside service (a stock library, the voice or model provider) was busy. A retry after `retry_after`
  is reasonable, and the server already retries short waits by itself.

## blocked_by_rule
HTTP 422. A brand rule marked as blocking matched the script. `check_ad` lists the findings with the rule and the quote.
Fix the script, or approve again with `override_reason` (recorded in the audit log). Not retryable as is.

## provider_unavailable
HTTP 503. An outside service failed, timed out or has been failing repeatedly (Hookmint pauses calls to a failing provider
for a short while), or the database is briefly unavailable. Retry after `retry_after` if given, with a growing delay. Retryable
unless `retryable` is false (for example, a rejected provider key: the message names the setting to fix).

## payload_too_large
HTTP 413. The request body is bigger than the server accepts. Send less. Not retryable.

## unsupported_media_type
HTTP 415. The body must be JSON (`Content-Type: application/json`). Not retryable until fixed.
