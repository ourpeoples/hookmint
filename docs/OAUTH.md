# Signing in with OAuth (ChatGPT, Claude, Cursor and other MCP clients)

Remote MCP clients connect with OAuth 2.1, not a pasted API key. Hookmint plays the part the MCP specification calls a
**resource server**: it checks access tokens and serves a discovery document. A separate **identity provider** (Auth0,
Clerk, WorkOS, Keycloak, Okta, ...) does the sign-in, the consent screen, client registration and token issuing. Hookmint
does not store passwords and does not run a login page.

API keys keep working alongside OAuth (`hmk_...` keys for scripts and Claude Code). Use either or both.

## What your identity provider must support

| Needed | Why |
| --- | --- |
| Signed JWT access tokens (RS256/ES256/PS256/EdDSA) | Hookmint checks them offline against the provider's published keys. Opaque tokens are not supported. |
| PKCE with S256 | Required by OAuth 2.1 and by MCP clients. |
| Dynamic client registration (RFC 7591), or pre-registered clients | ChatGPT and most MCP clients register themselves. Without it you register each client by hand. |
| An audience for the token (RFC 8707 `resource`, or a fixed API identifier) | Tokens must be issued **for this server**; a token for another API is refused. |
| A custom claim carrying the Hookmint account id | Accounts are invite-only. A sign-in without the claim gets 403, never an account of its own. |
| Scopes from this list in the `scope` (or `scp`) claim | `ads:read ads:create ads:approve spend brand:read brand:write insights:read ad_accounts:connect`. Unknown scopes are ignored. |

How to add the claim depends on the provider (an Action or rule in Auth0, a mapper in Keycloak, a JWT template in
Clerk). The claim name defaults to `hookmint_account_id`; its value is the account id, 1 to 64 letters, digits, `-`
or `_`. **Only your provider's administrators should be able to set it.** If users could choose their own value they
could pick someone else's account.

## Set up

```
HOOKMINT_PUBLIC_URL=https://hookmint.example.com          # this server, as clients reach it (https)
HOOKMINT_OAUTH_ISSUER=https://your-tenant.example.com/    # exactly the "iss" in the provider's tokens
HOOKMINT_OAUTH_AUDIENCE=                                  # optional; default: <public url>/mcp and <public url>
HOOKMINT_OAUTH_ACCOUNT_CLAIM=hookmint_account_id          # optional; the claim that holds the account id
```

Then give the account credits (there is no billing yet), as an operator:

```
npm run credits:grant -- --account acct_acme --amount 500 --reason "pilot"
```

In ChatGPT or Claude, add a custom connector with the address `https://hookmint.example.com/mcp`. The client reads
`/.well-known/oauth-protected-resource`, finds your provider, registers, sends the person through sign-in, and then calls
the server with a token.

## What Hookmint checks on every request

Signature (keys fetched from the provider's discovery document through the hardened fetcher, cached 10 minutes,
refreshed when an unknown key id appears, at most once every 30 seconds), issuer, audience, expiry and not-before (30
seconds of clock drift allowed), presence of `exp` and `sub`, and the account claim. The discovery document must name
the issuer you configured, so a lookalike provider cannot substitute its own keys. Tokens are never passed on to any
other service.

Failures: a bad, expired or wrongly addressed token is `401` with a `WWW-Authenticate` header that points to the
discovery document. A valid sign-in with no account or no usable scope is `403`. If the provider cannot be reached
(and no keys are cached) it is `503`. Only bad credentials count toward the failed-login limit, so a provider outage
never locks anyone out.

## Limits to know about

- There is no revocation check. A token stays valid until it expires, so keep access-token lifetimes short (5 to 15
  minutes) and let clients refresh.
- Opaque tokens and token introspection are not supported.
- This has been tested against a simulated provider, not against Auth0, Clerk, WorkOS or ChatGPT themselves. Each has its
  own quirks (claim names, how the audience is requested), so try a real sign-in before announcing it.
- Failed-login counting and rate limits are per instance.
