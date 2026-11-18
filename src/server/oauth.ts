import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import { ALL_SCOPES, type Ctx } from "../core/context.js";
import type { Fetched, FetchLimits } from "../net/safe-fetch.js";

export { ALL_SCOPES };

/**
 * Hookmint is an OAuth 2.1 resource server, as the MCP specification describes. A separate identity provider (Auth0,
 * Clerk, WorkOS, Keycloak, ...) signs people in, shows the consent screen, registers clients and issues access tokens.
 * Hookmint only checks the tokens: signature, issuer, audience, expiry and scopes. Nothing is ever forwarded to another
 * service with a client's token.
 */
export interface OAuthOptions {
  /** The identity provider's issuer URL, exactly as it appears in its tokens ("iss"). Must be https. */
  issuer: string;
  /** What tokens must be issued for ("aud"). Any one of these is accepted. Normally this server's public MCP address. */
  audiences: string[];
  /** This server's public address, used for the protected-resource metadata and the WWW-Authenticate hint. */
  resource: string;
  /** Name of the token claim that carries the Hookmint account id. A token without it is refused: accounts are invite-only. */
  accountClaim?: string;
  /**
   * Scopes given to a signed-in account whose token carries no Hookmint scope at all (some providers cannot put custom
   * scopes in tokens). A token that does name Hookmint scopes keeps exactly those. Leave unset to refuse such tokens.
   * Everyone invited gets these, so list only what every invited account should be allowed to do.
   */
  defaultScopes?: string[];
  /**
   * Refuse tokens issued longer ago than this, even if their own expiry is later. A signed token cannot be recalled, so
   * this is the ceiling on how long a leaked or revoked one keeps working. Unset means only the token's own expiry applies.
   */
  maxTokenAgeS?: number;
  /** Clock drift allowed on expiry and not-before. Default 30 seconds. */
  clockSkewS?: number;
  /** Narrow the accepted signing algorithms further (for example ["RS256"]). Default: the safe asymmetric set. */
  algorithms?: string[];
  /** Fetches the provider's discovery document and keys. Pass a SafeFetcher: these are outbound requests to a configured address. */
  fetcher: { get(url: string, limits: FetchLimits): Promise<Fetched> };
  now?: () => number;
  /** How long fetched keys are trusted. Default 10 minutes. */
  keysTtlMs?: number;
  /** Shortest wait between key refreshes forced by an unknown key id. Default 30 seconds. */
  refreshCooldownMs?: number;
}

export type OAuthResult =
  | { ok: true; ctx: Ctx; subject: string; clientId?: string }
  | { ok: false; reason: "invalid" | "expired" | "audience" | "issuer" | "account" | "scope" | "unavailable"; description: string };

export const ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "EdDSA"];
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOKEN = 8192;

export const looksLikeJwt = (token: string) => token.length <= MAX_TOKEN && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);

export class OAuthVerifier {
  private keys?: { set: ReturnType<typeof createLocalJWKSet>; at: number };
  private lastRefresh = 0;
  private loading?: Promise<void>;
  private readonly claim: string;
  private readonly now: () => number;

  constructor(private opts: OAuthOptions) {
    if (!/^https:\/\//.test(opts.issuer)) throw new Error("The OAuth issuer must be an https address.");
    if (!opts.audiences.length) throw new Error("At least one accepted audience is required.");
    for (const s of opts.defaultScopes ?? []) {
      if (!(ALL_SCOPES as readonly string[]).includes(s)) throw new Error(`Unknown default scope "${s}".`);
      if (s === "spend") throw new Error('"spend" cannot be a default scope: it would let every invited account spend credits. Put it in the tokens of the accounts that should have it.');
    }
    for (const a of opts.algorithms ?? []) if (!ALGORITHMS.includes(a)) throw new Error(`Algorithm "${a}" is not one of the accepted asymmetric algorithms: ${ALGORITHMS.join(", ")}.`);
    if (opts.maxTokenAgeS !== undefined && !(opts.maxTokenAgeS >= 60)) throw new Error("The maximum token age must be at least 60 seconds.");
    if (opts.clockSkewS !== undefined && !(opts.clockSkewS >= 0 && opts.clockSkewS <= 120)) throw new Error("Clock skew must be between 0 and 120 seconds.");
    this.claim = opts.accountClaim ?? "hookmint_account_id";
    this.now = opts.now ?? Date.now;
  }

  /** RFC 9728 protected-resource metadata, so a client that gets a 401 can find the authorization server. */
  metadata() {
    return {
      resource: this.opts.resource,
      authorization_servers: [this.opts.issuer],
      // No scopes_supported on purpose: clients ask the authorization server for whatever is listed here, and an identity
      // provider such as AuthKit refuses scopes it does not know (ads:read and the rest are Hookmint's own, granted from
      // the account's token claim or the configured defaults, never requested through the provider).
      bearer_methods_supported: ["header"],
      resource_name: "Hookmint",
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const got = await this.opts.fetcher.get(url, { maxBytes: 262_144, accept: ["application/json", "application/jwk-set+json"], timeoutMs: 10_000 });
    return JSON.parse(got.bytes.toString("utf8"));
  }

  /** Fetches the discovery document, checks it names the issuer we expect, then fetches the keys. */
  private async refresh(): Promise<void> {
    const base = this.opts.issuer.replace(/\/+$/, "");
    let doc: { issuer?: string; jwks_uri?: string } | undefined;
    for (const path of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
      try {
        doc = (await this.getJson(`${base}${path}`)) as typeof doc;
        if (doc?.jwks_uri) break;
      } catch {
        doc = undefined;
      }
    }
    // A document that names a different issuer is not this provider's: refuse it (authorization server mix-up).
    if (!doc || doc.issuer?.replace(/\/+$/, "") !== base || !doc.jwks_uri || !/^https:\/\//.test(doc.jwks_uri)) throw new Error("discovery failed");
    const jwks = (await this.getJson(doc.jwks_uri)) as JSONWebKeySet;
    if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error("no keys");
    this.keys = { set: createLocalJWKSet(jwks), at: this.now() };
    this.lastRefresh = this.now();
  }

  private async ensureKeys(force = false): Promise<void> {
    const ttl = this.opts.keysTtlMs ?? 600_000;
    const stale = !this.keys || this.now() - this.keys.at > ttl;
    const allowed = this.now() - this.lastRefresh > (this.opts.refreshCooldownMs ?? 30_000);
    if (!stale && !(force && allowed)) return;
    this.loading ??= this.refresh().finally(() => (this.loading = undefined));
    try {
      await this.loading;
    } catch (err) {
      if (!this.keys) throw err; // with old keys in hand, a failed refresh is not fatal
    }
  }

  async verify(token: string): Promise<OAuthResult> {
    if (!looksLikeJwt(token)) return { ok: false, reason: "invalid", description: "The access token is not a JWT." };
    try {
      await this.ensureKeys();
    } catch {
      return { ok: false, reason: "unavailable", description: "The identity provider's keys could not be fetched." };
    }
    const attempt = () =>
      jwtVerify(token, (h, t) => this.keys!.set(h, t), {
        issuer: this.opts.issuer,
        audience: this.opts.audiences,
        algorithms: this.opts.algorithms?.length ? this.opts.algorithms : ALGORITHMS,
        clockTolerance: this.opts.clockSkewS ?? 30,
        ...(this.opts.maxTokenAgeS !== undefined ? { maxTokenAge: this.opts.maxTokenAgeS } : {}),
        requiredClaims: ["exp", "sub"],
        currentDate: new Date(this.now()),
      });
    let result;
    try {
      try {
        result = await attempt();
      } catch (err) {
        if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err;
        await this.ensureKeys(true).catch(() => undefined); // the provider may have rotated keys
        result = await attempt();
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired", description: err.claim === "iat" ? "The access token was issued longer ago than this server accepts. Sign in again." : "The access token has expired." };
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        if (err.claim === "aud") return { ok: false, reason: "audience", description: "The access token was not issued for this server." };
        if (err.claim === "iss") return { ok: false, reason: "issuer", description: "The access token was issued by an unexpected provider." };
      }
      return { ok: false, reason: "invalid", description: "The access token is not valid." };
    }
    const p = result.payload;
    const account = p[this.claim];
    if (typeof account !== "string" || !ACCOUNT_ID.test(account)) {
      return { ok: false, reason: "account", description: "This sign-in is not linked to a Hookmint account. Accounts are invite-only." };
    }
    const raw = typeof p.scope === "string" ? p.scope : Array.isArray(p.scp) ? p.scp.filter((s): s is string => typeof s === "string").join(" ") : "";
    const granted = new Set(raw.split(/\s+/).filter((s) => (ALL_SCOPES as readonly string[]).includes(s)));
    if (!granted.size) for (const s of this.opts.defaultScopes ?? []) granted.add(s);
    if (!granted.size) return { ok: false, reason: "scope", description: "The access token grants no Hookmint scopes." };
    const clientId = typeof p.client_id === "string" ? p.client_id : typeof p.azp === "string" ? p.azp : undefined;
    return { ok: true, ctx: { accountId: account, scopes: granted }, subject: String(p.sub), clientId };
  }
}
