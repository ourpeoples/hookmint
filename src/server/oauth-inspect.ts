import { decodeJwt, decodeProtectedHeader } from "jose";
import { ALL_SCOPES } from "../core/context.js";
import type { ServerConfig } from "./config.js";

export interface Inspection {
  lines: string[];
  problems: string[];
}

const when = (s: number) => `${new Date(s * 1000).toISOString()}`;

/**
 * Explains an access token against the server's OAuth settings, so a person can see why a sign-in is refused.
 * It READS the token and does NOT verify its signature: the output says what the token claims, not that it is genuine.
 */
export function inspectToken(token: string, oauth: NonNullable<ServerConfig["oauth"]>, now = Date.now()): Inspection {
  const lines: string[] = [];
  const problems: string[] = [];
  let header: ReturnType<typeof decodeProtectedHeader>;
  let p: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(token);
    p = decodeJwt(token);
  } catch {
    return { lines, problems: ["This is not a JWT (three dot-separated parts). Hookmint needs signed JWT access tokens. If the provider issues opaque tokens, change its settings (often: request an audience / resource so it issues JWTs)."] };
  }
  const claim = oauth.accountClaim ?? "hookmint_account_id";
  lines.push(`signing algorithm: ${header.alg ?? "?"}${header.kid ? `, key id ${header.kid}` : ", no key id"}`);
  lines.push(`issuer (iss):      ${p.iss ?? "(missing)"}`);
  lines.push(`audience (aud):    ${JSON.stringify(p.aud ?? "(missing)")}`);
  lines.push(`subject (sub):     ${p.sub ?? "(missing)"}`);
  lines.push(`expires (exp):     ${p.exp ? when(p.exp) : "(missing)"}`);

  if (p.iss !== oauth.issuer) problems.push(`The token's issuer is ${JSON.stringify(p.iss)} but HOOKMINT_OAUTH_ISSUER is ${JSON.stringify(oauth.issuer)}. They must match exactly, including any trailing slash.`);
  const aud = ([] as string[]).concat((p.aud as string | string[] | undefined) ?? []);
  if (!aud.some((a) => oauth.audiences.includes(a))) problems.push(`The token's audience ${JSON.stringify(p.aud ?? null)} is none of the accepted audiences ${JSON.stringify(oauth.audiences)}. Make the provider issue the token for this server (its resource or API identifier), or set HOOKMINT_OAUTH_AUDIENCE.`);
  if (!p.sub) problems.push("The token has no subject (sub).");
  if (!p.exp) problems.push("The token has no expiry (exp). Hookmint refuses tokens that never expire.");
  else if (p.exp * 1000 < now - 30_000) problems.push(`The token expired at ${when(p.exp)}. Get a fresh one.`);

  if (oauth.maxTokenAgeS !== undefined) {
    if (typeof p.iat !== "number") problems.push("The token has no issue time (iat), and HOOKMINT_OAUTH_MAX_TOKEN_AGE_S is set, so it is refused.");
    else if (now - p.iat * 1000 > oauth.maxTokenAgeS * 1000 + (oauth.clockSkewS ?? 30) * 1000) problems.push(`The token was issued ${Math.round((now - p.iat * 1000) / 1000)} seconds ago, longer than HOOKMINT_OAUTH_MAX_TOKEN_AGE_S (${oauth.maxTokenAgeS}). Get a fresh one.`);
  }
  const value = p[claim];
  lines.push(`${claim}: ${value === undefined ? "(missing)" : JSON.stringify(value)}`);
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) problems.push(`The account claim "${claim}" is ${value === undefined ? "missing" : "not a valid account id"}. Add it to the provider's token template (1 to 64 letters, digits, - or _). Without it the sign-in gets 403.`);

  const raw = typeof p.scope === "string" ? p.scope : Array.isArray(p.scp) ? p.scp.filter((s): s is string => typeof s === "string").join(" ") : "";
  const named = raw.split(/\s+/).filter(Boolean);
  const known = named.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
  lines.push(`scopes in token:   ${named.length ? named.join(" ") : "(none)"}`);
  if (known.length) lines.push(`Hookmint scopes:   ${known.join(" ")}`);
  else if (oauth.defaultScopes?.length) lines.push(`Hookmint scopes:   none in the token, so the default scopes apply: ${oauth.defaultScopes.join(" ")}`);
  else problems.push("The token names no Hookmint scope, and HOOKMINT_OAUTH_DEFAULT_SCOPES is not set, so every call would be refused. Put scopes like ads:read in the token, or set HOOKMINT_OAUTH_DEFAULT_SCOPES.");
  return { lines, problems };
}
