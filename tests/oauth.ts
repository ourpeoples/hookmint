import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { AdError } from "../src/core/errors.js";
import { createApp } from "../src/server/app.js";
import { ApiKeys } from "../src/server/api-keys.js";
import { OAuthVerifier } from "../src/server/oauth.js";
import { loadConfig } from "../src/server/config.js";
import { inspectToken } from "../src/server/oauth-inspect.js";
import type { FetchLimits } from "../src/net/safe-fetch.js";
import { key, setup } from "./helpers.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

const ISSUER = "https://idp.example.com/";
const RESOURCE = "https://hookmint.example.com/mcp";
const clock = () => { const c = { t: Date.parse("2026-06-01T12:00:00Z") }; return Object.assign(() => c.t, { advance: (ms: number) => (c.t += ms) }); };

interface Pair { privateKey: CryptoKey; jwk: JWK }
async function pair(kid: string, alg = "RS256"): Promise<Pair> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } };
}
/** A pretend identity provider: a discovery document and a key set, with a count of how often each was fetched. */
function idp(keys: Pair[], over: { issuer?: string; jwks_uri?: string; fail?: boolean } = {}) {
  const state = { keys, hits: { discovery: 0, jwks: 0 }, fail: over.fail ?? false };
  const fetcher = {
    async get(url: string, _limits: FetchLimits) {
      if (state.fail) throw new AdError("provider_unavailable", "down");
      const json = (v: unknown) => ({ bytes: Buffer.from(JSON.stringify(v)), contentType: "application/json", finalUrl: url });
      if (url === "https://idp.example.com/.well-known/openid-configuration") {
        state.hits.discovery++;
        return json({ issuer: over.issuer ?? "https://idp.example.com/", jwks_uri: over.jwks_uri ?? "https://idp.example.com/keys" });
      }
      if (url === (over.jwks_uri ?? "https://idp.example.com/keys")) {
        state.hits.jwks++;
        return json({ keys: state.keys.map((k) => k.jwk) });
      }
      throw new AdError("not_found", "no such url");
    },
  };
  return { state, fetcher };
}

const good = (over: Record<string, unknown> = {}) => ({ sub: "user-1", scope: "ads:read ads:create ads:approve spend brand:read brand:write", hookmint_account_id: "acct_a", ...over });
async function sign(p: Pair, claims: Record<string, unknown>, o: { iss?: string; aud?: string | string[]; exp?: number | string; iat?: number; nbf?: number; alg?: string; kid?: string | null } = {}, now = Date.parse("2026-06-01T12:00:00Z")) {
  let jwt = new SignJWT(claims as never)
    .setProtectedHeader({ alg: o.alg ?? "RS256", ...(o.kid === null ? {} : { kid: o.kid ?? (p.jwk.kid as string) }) })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? RESOURCE)
    .setIssuedAt(o.iat ?? Math.floor(now / 1000))
    .setExpirationTime(o.exp ?? Math.floor(now / 1000) + 600);
  if (o.nbf !== undefined) jwt = jwt.setNotBefore(o.nbf);
  return jwt.sign(p.privateKey);
}
const verifier = (f: ReturnType<typeof idp>["fetcher"], now = clock(), extra = {}) => new OAuthVerifier({ issuer: ISSUER, audiences: [RESOURCE, "https://hookmint.example.com"], resource: RESOURCE, fetcher: f, now, ...extra });
const refused = async (v: OAuthVerifier, token: string, reason: string, why: string) => {
  const r = await v.verify(token);
  assert.equal(r.ok, false, `${why}: should be refused`);
  if (!r.ok) assert.equal(r.reason, reason, `${why}: reason`);
};

const K1 = await pair("k1");

await test("a good token is accepted: the account comes from the claim and the scopes from the token", async () => {
  const { fetcher } = idp([K1]);
  const r = await verifier(fetcher).verify(await sign(K1, good()));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.ctx.accountId, "acct_a");
    assert.deepEqual([...r.ctx.scopes].sort(), ["ads:approve", "ads:create", "ads:read", "brand:read", "brand:write", "spend"]);
    assert.equal(r.subject, "user-1");
  }
  const narrow = await verifier(fetcher).verify(await sign(K1, good({ scope: "ads:read made-up:scope", client_id: "chatgpt" })));
  assert.ok(narrow.ok && [...narrow.ctx.scopes].join() === "ads:read" && narrow.clientId === "chatgpt", "unknown scopes are ignored");
  const arr = await verifier(fetcher).verify(await sign(K1, good({ scope: undefined, scp: ["ads:read", "brand:read"] })));
  assert.ok(arr.ok && arr.ctx.scopes.size === 2, "the scp array form works too");
  const second = await verifier(fetcher).verify(await sign(K1, good(), { aud: "https://hookmint.example.com" }));
  assert.ok(second.ok, "either configured audience is accepted");
});

await test("tokens for the wrong issuer, the wrong audience, or no audience are refused", async () => {
  const { fetcher } = idp([K1]);
  const v = verifier(fetcher);
  await refused(v, await sign(K1, good(), { iss: "https://evil.example.com/" }), "issuer", "wrong issuer");
  await refused(v, await sign(K1, good(), { aud: "https://other-api.example.com" }), "audience", "token for another service");
  await refused(v, await sign(K1, good(), { aud: ["https://other-api.example.com", "https://third.example.com"] }), "audience", "list without us");
  const noAud = await new SignJWT(good() as never).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setExpirationTime("10m").sign(K1.privateKey);
  await refused(v, noAud, "audience", "no audience at all");
});

await test("expired, not-yet-valid and exp-less tokens are refused; a few seconds of clock drift is allowed", async () => {
  const { fetcher } = idp([K1]);
  const now = clock();
  const v = verifier(fetcher, now);
  const t0 = now();
  await refused(v, await sign(K1, good(), { exp: Math.floor(t0 / 1000) - 120 }), "expired", "expired");
  assert.ok((await v.verify(await sign(K1, good(), { exp: Math.floor(t0 / 1000) - 10 }))).ok, "10 seconds late is within tolerance");
  await refused(v, await sign(K1, good(), { nbf: Math.floor(t0 / 1000) + 3600 }), "invalid", "not yet valid");
  const noExp = await new SignJWT(good() as never).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(RESOURCE).sign(K1.privateKey);
  await refused(v, noExp, "invalid", "no expiry");
  const tok = await sign(K1, good());
  now.advance(11 * 60_000);
  await refused(v, tok, "expired", "the same token later");
});

await test("forged tokens are refused: another key, a tampered body, alg none, and the HS256 trick with the public key as secret", async () => {
  const { fetcher } = idp([K1]);
  const v = verifier(fetcher);
  const attacker = await pair("k1"); // same key id, different key
  await refused(v, await sign(attacker, good()), "invalid", "signed with another key");
  const tok = await sign(K1, good());
  const [h, p, s] = tok.split(".");
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), hookmint_account_id: "acct_victim" })).toString("base64url");
  await refused(v, `${h}.${evil}.${s}`, "invalid", "edited body");
  const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
  await refused(v, none, "invalid", "alg none");
  const hsHeader = Buffer.from(JSON.stringify({ alg: "HS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const mac = createHmac("sha256", JSON.stringify(K1.jwk)).update(`${hsHeader}.${p}`).digest("base64url");
  await refused(v, `${hsHeader}.${p}.${mac}`, "invalid", "HS256 with the public key as the secret");
  await refused(v, "not-a-jwt", "invalid", "garbage");
  await refused(v, "a.b.c", "invalid", "three junk parts");
  await refused(v, `${"A".repeat(9000)}.${"B".repeat(10)}.${"C".repeat(10)}`, "invalid", "oversized");
});

await test("a valid token with no Hookmint account or no usable scope is a permission problem, not a bad credential", async () => {
  const { fetcher } = idp([K1]);
  const v = verifier(fetcher);
  await refused(v, await sign(K1, good({ hookmint_account_id: undefined })), "account", "no account claim");
  await refused(v, await sign(K1, good({ hookmint_account_id: "../etc/passwd" })), "account", "unsafe account claim");
  await refused(v, await sign(K1, good({ hookmint_account_id: 42 })), "account", "non-string account claim");
  await refused(v, await sign(K1, good({ scope: "openid profile email" })), "scope", "no Hookmint scopes");
  const custom = verifier(fetcher, clock(), { accountClaim: "https://example.com/account" });
  const r = await custom.verify(await sign(K1, good({ hookmint_account_id: undefined, "https://example.com/account": "acct_z" })));
  assert.ok(r.ok && r.ctx.accountId === "acct_z", "the claim name is configurable");
});

await test("keys: fetched once and cached, refetched after rotation (not more than once per cooldown), and the provider's outage does not look like a bad token", async () => {
  const now = clock();
  const k2 = await pair("k2");
  const p = idp([K1]);
  const v = verifier(p.fetcher, now);
  for (let i = 0; i < 5; i++) assert.ok((await v.verify(await sign(K1, good()))).ok);
  assert.deepEqual(p.state.hits, { discovery: 1, jwks: 1 }, "one fetch serves many tokens");
  p.state.keys = [K1, k2]; // the provider rotates in a new key
  await refused(v, await sign(k2, good()), "invalid", "a new key inside the cooldown is not fetched yet");
  now.advance(31_000);
  assert.ok((await v.verify(await sign(k2, good()))).ok, "after the cooldown an unknown key id triggers one refresh");
  assert.equal(p.state.hits.jwks, 2);
  const bogus = await pair("never-published");
  now.advance(31_000);
  for (let i = 0; i < 4; i++) await refused(v, await sign(bogus, good()), "invalid", "unknown key id");
  assert.equal(p.state.hits.jwks, 3, "a flood of unknown key ids causes one refresh, not one each");
  now.advance(11 * 60_000);
  p.state.fail = true;
  assert.ok((await v.verify(await sign(K1, good(), {}, now()))).ok, "stale keys keep working while the provider is down");
  const cold = verifier(p.fetcher, clock());
  await refused(cold, await sign(K1, good()), "unavailable", "no keys and the provider is down");
});

await test("discovery is checked: a document that names another issuer, or a non-https key address, is refused", async () => {
  await refused(verifier(idp([K1], { issuer: "https://evil.example.com/" }).fetcher), await sign(K1, good()), "unavailable", "issuer mismatch in discovery");
  await refused(verifier(idp([K1], { jwks_uri: "http://idp.example.com/keys" }).fetcher), await sign(K1, good()), "unavailable", "plain http key address");
  assert.throws(() => new OAuthVerifier({ issuer: "http://idp.example.com", audiences: [RESOURCE], resource: RESOURCE, fetcher: idp([]).fetcher }), /https/);
  assert.throws(() => new OAuthVerifier({ issuer: ISSUER, audiences: [], resource: RESOURCE, fetcher: idp([]).fetcher }), /audience/);
});

await test("default scopes: used only when the token names no Hookmint scope, never to widen a token that does", async () => {
  const { fetcher } = idp([K1]);
  const withDefaults = verifier(fetcher, clock(), { defaultScopes: ["ads:read", "ads:create"] });
  const bare = await withDefaults.verify(await sign(K1, good({ scope: undefined })));
  assert.ok(bare.ok && [...bare.ctx.scopes].sort().join() === "ads:create,ads:read", "no scope claim at all");
  const oidcOnly = await withDefaults.verify(await sign(K1, good({ scope: "openid profile email" })));
  assert.ok(oidcOnly.ok && oidcOnly.ctx.scopes.size === 2, "only non-Hookmint scopes");
  const narrow = await withDefaults.verify(await sign(K1, good({ scope: "ads:read" })));
  assert.ok(narrow.ok && [...narrow.ctx.scopes].join() === "ads:read", "a token that names scopes keeps exactly those");
  await refused(verifier(fetcher), await sign(K1, good({ scope: undefined })), "scope", "without defaults a scope-less token is refused");
  assert.throws(() => verifier(fetcher, clock(), { defaultScopes: ["root"] }), /Unknown default scope/);
  const c = loadConfig({ HOOKMINT_OAUTH_ISSUER: "https://idp.example.com/", HOOKMINT_PUBLIC_URL: "https://h.example.com", HOOKMINT_OAUTH_DEFAULT_SCOPES: "ads:read, brand:read" });
  assert.deepEqual(c.oauth?.defaultScopes, ["ads:read", "brand:read"]);
  assert.throws(() => loadConfig({ HOOKMINT_OAUTH_ISSUER: "https://idp.example.com/", HOOKMINT_PUBLIC_URL: "https://h.example.com", HOOKMINT_OAUTH_DEFAULT_SCOPES: "ads:read root" }), /unknown scope "root"/);
});

await test("hardening: a ceiling on token age, configurable clock skew, a narrower algorithm list, and no spend by default", async () => {
  const { fetcher } = idp([K1]);
  const now = clock();
  const t0 = Math.floor(now() / 1000);
  const old = await sign(K1, good(), { iat: t0 - 1200, exp: t0 + 3600 }); // issued 20 minutes ago, valid for another hour
  assert.ok((await verifier(fetcher, now).verify(old)).ok, "without a ceiling only the token's own expiry applies");
  const capped = verifier(fetcher, now, { maxTokenAgeS: 600 });
  const r = await capped.verify(old);
  assert.ok(!r.ok && r.reason === "expired" && /longer ago than this server accepts/.test(r.description), "too old for the ceiling, even though not expired");
  assert.ok((await capped.verify(await sign(K1, good(), { iat: t0 - 300, exp: t0 + 3600 }))).ok, "recent enough");
  const noIat = await new SignJWT(good() as never).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(RESOURCE).setExpirationTime(t0 + 3600).sign(K1.privateKey);
  await refused(capped, noIat, "invalid", "a token with no issue time cannot be aged, so it is refused when a ceiling is set");
  // clock skew
  const lateBy45 = await sign(K1, good(), { exp: t0 - 45, iat: t0 - 900 });
  await refused(verifier(fetcher, now), lateBy45, "expired", "45 seconds late with the default 30 second skew");
  assert.ok((await verifier(fetcher, now, { clockSkewS: 60 }).verify(lateBy45)).ok, "accepted with 60 seconds of skew");
  await refused(verifier(fetcher, now, { clockSkewS: 0 }), await sign(K1, good(), { exp: t0 - 5, iat: t0 - 900 }), "expired", "no skew allowed");
  // algorithms
  const es = await pair("e1", "ES256");
  const esFetcher = idp([K1, es]).fetcher;
  assert.ok((await verifier(esFetcher, now).verify(await sign(es, good(), { alg: "ES256", kid: "e1" }))).ok);
  const rsOnly = verifier(esFetcher, now, { algorithms: ["RS256"] });
  await refused(rsOnly, await sign(es, good(), { alg: "ES256", kid: "e1" }), "invalid", "ES256 when only RS256 is allowed");
  assert.ok((await rsOnly.verify(await sign(K1, good()))).ok);
  assert.throws(() => verifier(fetcher, now, { algorithms: ["HS256"] }), /not one of the accepted asymmetric/);
  assert.throws(() => verifier(fetcher, now, { maxTokenAgeS: 5 }), /at least 60/);
  assert.throws(() => verifier(fetcher, now, { clockSkewS: 500 }), /between 0 and 120/);
  // defaults can never include spend
  assert.throws(() => verifier(fetcher, now, { defaultScopes: ["ads:read", "spend"] }), /"spend" cannot be a default scope/);
  const env = { HOOKMINT_OAUTH_ISSUER: "https://idp.example.com/", HOOKMINT_PUBLIC_URL: "https://h.example.com" };
  assert.throws(() => loadConfig({ ...env, HOOKMINT_OAUTH_DEFAULT_SCOPES: "ads:read spend" }), /cannot include "spend"/);
  const c = loadConfig({ ...env, HOOKMINT_OAUTH_MAX_TOKEN_AGE_S: "300", HOOKMINT_OAUTH_CLOCK_SKEW_S: "45", HOOKMINT_OAUTH_ALGORITHMS: "RS256, ES256" });
  assert.deepEqual([c.oauth?.maxTokenAgeS, c.oauth?.clockSkewS, c.oauth?.algorithms], [300, 45, ["RS256", "ES256"]]);
  assert.throws(() => loadConfig({ ...env, HOOKMINT_OAUTH_ALGORITHMS: "HS256" }), /not an accepted asymmetric algorithm/);
  assert.throws(() => loadConfig({ ...env, HOOKMINT_OAUTH_MAX_TOKEN_AGE_S: "10" }), /at least 60/);
  assert.throws(() => loadConfig({ ...env, HOOKMINT_OAUTH_CLOCK_SKEW_S: "999" }), /HOOKMINT_OAUTH_CLOCK_SKEW_S/);
  // the production warning, and the inspector's view of the same rule
  const prod = { ...env, HOOKMINT_ENV: "production", HOOKMINT_URL_SECRET: "s".repeat(32), HOOKMINT_ALLOW_EPHEMERAL: "1" };
  assert.ok(loadConfig(prod).warnings.some((w) => /MAX_TOKEN_AGE_S is not set/.test(w)));
  assert.ok(!loadConfig({ ...prod, HOOKMINT_OAUTH_MAX_TOKEN_AGE_S: "300" }).warnings.some((w) => /MAX_TOKEN_AGE_S/.test(w)));
  const cfg = { issuer: ISSUER, audiences: [RESOURCE], resource: RESOURCE, maxTokenAgeS: 600 };
  assert.match(inspectToken(old, cfg, now()).problems.join(), /issued 1200 seconds ago, longer than HOOKMINT_OAUTH_MAX_TOKEN_AGE_S \(600\)/);
  assert.match(inspectToken(noIat, cfg, now()).problems.join(), /no issue time/);
});

await test("token inspector: explains each reason a sign-in would be refused, and says it did not verify the signature", async () => {
  const cfg = { issuer: ISSUER, audiences: [RESOURCE], resource: RESOURCE };
  const now = Date.parse("2026-06-01T12:00:00Z");
  const ok = inspectToken(await sign(K1, good()), cfg, now);
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.lines.some((l) => /hookmint_account_id: "acct_a"/.test(l)));
  const wrong = inspectToken(await sign(K1, good({ hookmint_account_id: undefined, scope: "openid" }), { iss: "https://other.example/", aud: "api://something" }), cfg, now).problems.join("\n");
  assert.match(wrong, /issuer is "https:\/\/other\.example\/"/);
  assert.match(wrong, /audience "api:\/\/something" is none of the accepted/);
  assert.match(wrong, /account claim "hookmint_account_id" is missing/);
  assert.match(wrong, /names no Hookmint scope/);
  assert.match(inspectToken(await sign(K1, good(), { exp: Math.floor(now / 1000) - 3600 }), cfg, now).problems.join(), /expired at/);
  assert.match(inspectToken("opaque-token-value", cfg, now).problems[0], /not a JWT/);
  const withDefault = inspectToken(await sign(K1, good({ scope: undefined })), { ...cfg, defaultScopes: ["ads:read"] }, now);
  assert.deepEqual(withDefault.problems, []);
  assert.ok(withDefault.lines.some((l) => /default scopes apply: ads:read/.test(l)));
});

// ============ over HTTP ============

async function serve(opts: { oauth?: OAuthVerifier; keys?: ApiKeys; limits?: { authFailuresPer10Min: number } } = {}) {
  const svc = await setup();
  if (opts.limits) Object.assign(svc.service.limits, opts.limits);
  const server = createApp(svc.service, { oauth: opts.oauth, apiKeys: opts.keys }).listen(0);
  return { ...svc, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

await test("HTTP: a signed-in client reaches REST and MCP, sees only its own account, and an unauthenticated one gets a discovery hint", async () => {
  const p = idp([K1]);
  const { server, base, service } = await serve({ oauth: verifier(p.fetcher) });
  try {
    await service.grantCredits("acct_a", 50, "t");
    const tokA = await sign(K1, good());
    const created = await fetch(`${base}/v1/ads`, { method: "POST", headers: { ...bearer(tokA), "idempotency-key": key() }, body: JSON.stringify({ prompt: "An ad made through an OAuth sign-in" }) });
    assert.equal(created.status, 201);
    const mine = (await (await fetch(`${base}/v1/ads`, { headers: bearer(tokA) })).json()) as { ads: unknown[] };
    assert.equal(mine.ads.length, 1);
    const tokB = await sign(K1, good({ hookmint_account_id: "acct_b", sub: "user-2" }));
    const theirs = (await (await fetch(`${base}/v1/ads`, { headers: bearer(tokB) })).json()) as { ads: unknown[] };
    assert.equal(theirs.ads.length, 0, "another account's token sees nothing of acct_a");
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { ...bearer(tokA), accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /create_ad/);
    const none = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(none.status, 401);
    const hint = none.headers.get("www-authenticate")!;
    assert.match(hint, /^Bearer /);
    assert.match(hint, /resource_metadata="https:\/\/hookmint\.example\.com\/\.well-known\/oauth-protected-resource"/);
    assert.ok(!/error=/.test(hint), "no token was sent, so no invalid_token error");
    const bad = await fetch(`${base}/v1/ads`, { headers: bearer(await sign(K1, good(), { aud: "https://other.example.com" })) });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate")!, /error="invalid_token", error_description="The access token was not issued for this server\."/);
    const noAccount = await fetch(`${base}/v1/ads`, { headers: bearer(await sign(K1, good({ hookmint_account_id: undefined }))) });
    assert.equal(noAccount.status, 403, "signed in but not invited");
    assert.match(((await noAccount.json()) as { error: { message: string } }).error.message, /invite-only/);
  } finally { server.close(); }
});

await test("HTTP: scopes in the token limit what the client can do", async () => {
  const { server, base } = await serve({ oauth: verifier(idp([K1]).fetcher) });
  try {
    const readOnly = await sign(K1, good({ scope: "ads:read" }));
    assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(readOnly) })).status, 200);
    const denied = await fetch(`${base}/v1/ads`, { method: "POST", headers: { ...bearer(readOnly), "idempotency-key": key() }, body: JSON.stringify({ prompt: "A read-only token cannot create ads" }) });
    assert.equal(denied.status, 403);
    assert.match(((await denied.json()) as { error: { message: string } }).error.message, /ads:create/);
  } finally { server.close(); }
});

await test("HTTP: the discovery document is public and correct, and absent when OAuth is off", async () => {
  const on = await serve({ oauth: verifier(idp([K1]).fetcher) });
  try {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`${on.base}${p}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("cache-control")!, /public/);
      const m = (await r.json()) as Record<string, unknown>;
      assert.equal(m.resource, RESOURCE);
      assert.deepEqual(m.authorization_servers, [ISSUER]);
      assert.deepEqual(m.bearer_methods_supported, ["header"]);
      assert.equal(m.scopes_supported, undefined, "our own scopes must not be advertised: the identity provider would reject them");
    }
  } finally { on.server.close(); }
  const off = await serve();
  try { assert.equal((await fetch(`${off.base}/.well-known/oauth-protected-resource`)).status, 404); } finally { off.server.close(); }
});

await test("HTTP: API keys and OAuth tokens work side by side, and each is checked only as what it is", async () => {
  const k = ApiKeys.generate("acct_keys");
  const { server, base } = await serve({ oauth: verifier(idp([K1]).fetcher), keys: new ApiKeys([k.record]) });
  try {
    assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(k.token) })).status, 200, "an API key still works");
    assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(await sign(K1, good())) })).status, 200, "an OAuth token works");
    const wrongKey = await fetch(`${base}/v1/ads`, { headers: bearer("hmk_" + "x".repeat(40)) });
    assert.equal(wrongKey.status, 401);
    assert.equal((await fetch(`${base}/v1/ads`)).status, 401);
  } finally { server.close(); }
});

await test("HTTP: bad tokens count toward the failed-login limit, valid ones never do, and a provider outage counts as neither", async () => {
  const p = idp([K1]);
  const { server, base } = await serve({ oauth: verifier(p.fetcher), limits: { authFailuresPer10Min: 3 } });
  try {
    const goodTok = await sign(K1, good());
    const forged = await sign(await pair("k1"), good());
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(forged) })).status, 401);
    assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(forged) })).status, 429, "repeated bad tokens are slowed down");
    assert.equal((await fetch(`${base}/v1/ads`, { headers: bearer(goodTok) })).status, 200, "a valid token is still welcome");
  } finally { server.close(); }
  const outage = idp([K1], { });
  outage.state.fail = true;
  const o = await serve({ oauth: verifier(outage.fetcher), limits: { authFailuresPer10Min: 2 } });
  try {
    const tok = await sign(K1, good());
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${o.base}/v1/ads`, { headers: bearer(tok) })).status, 503, "the provider being down is a 503, never a lockout");
    outage.state.fail = false;
    assert.equal((await fetch(`${o.base}/v1/ads`, { headers: bearer(tok) })).status, 200, "and service resumes at once");
  } finally { o.server.close(); }
});

await test("config: OAuth needs an https issuer and a public address; production may run on OAuth alone", async () => {
  const base = { HOOKMINT_OAUTH_ISSUER: "https://idp.example.com/", HOOKMINT_PUBLIC_URL: "https://hookmint.example.com/" };
  const c = loadConfig(base);
  assert.deepEqual(c.oauth, { issuer: "https://idp.example.com/", audiences: ["https://hookmint.example.com/mcp", "https://hookmint.example.com"], resource: "https://hookmint.example.com/mcp", accountClaim: undefined, clockSkewS: 30 });
  assert.deepEqual(loadConfig({ ...base, HOOKMINT_OAUTH_AUDIENCE: "api://hookmint, https://x.example/mcp", HOOKMINT_OAUTH_ACCOUNT_CLAIM: "https://x/acct" }).oauth?.audiences, ["api://hookmint", "https://x.example/mcp"]);
  assert.throws(() => loadConfig({ HOOKMINT_OAUTH_ISSUER: "http://idp.example.com" , HOOKMINT_PUBLIC_URL: "https://h.example.com" }), /https address/);
  assert.throws(() => loadConfig({ HOOKMINT_OAUTH_ISSUER: "https://idp.example.com" }), /HOOKMINT_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...base, HOOKMINT_PUBLIC_URL: "http://h.example.com" }), /HOOKMINT_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...base, HOOKMINT_OAUTH_ACCOUNT_CLAIM: "bad claim!" }), /claim name/);
  const prod = { ...base, HOOKMINT_ENV: "production", HOOKMINT_URL_SECRET: "s".repeat(32), HOOKMINT_DATABASE_URL: "postgres://a@h/d", HOOKMINT_DATABASE_WORKER_URL: "postgres://b@h/d" };
  assert.ok(loadConfig(prod).oauth, "production with OAuth and no API keys starts");
  assert.throws(() => loadConfig({ ...prod, HOOKMINT_OAUTH_ISSUER: "" , HOOKMINT_PUBLIC_URL: "" }), /API keys.*OAuth|OAuth/);
});

console.log(`oauth: ${n} tests passed`);
process.exit(0);
