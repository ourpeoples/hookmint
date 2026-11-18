import { ALL_SCOPES } from "../core/context.js";
import { levelFromEnv, type Level } from "../core/logger.js";
import { ApiKeys } from "./api-keys.js";
import { ALGORITHMS as OAUTH_ALGORITHMS } from "./oauth.js";
import { DEFAULT_MAX_BODY } from "./app.js";

export interface ServerConfig {
  port: number;
  production: boolean;
  apiKeys?: ApiKeys;
  corsOrigins: string[];
  maxBodyBytes: number;
  logLevel: Level;
  hsts: boolean;
  initialCredits: number;
  /** Connection strings for the two runtime database roles. Without them state is held in memory. */
  database?: { appUrl: string; workerUrl: string };
  /** Accept OAuth 2.1 access tokens from this identity provider. */
  oauth?: { issuer: string; audiences: string[]; resource: string; accountClaim?: string; defaultScopes?: string[]; spendAccounts?: string[]; maxTokenAgeS?: number; clockSkewS?: number; algorithms?: string[] };
  /** Things that are allowed but probably not what you want. Logged at startup; they never stop the server. */
  warnings: string[];
  /** Bearer token for GET /metrics. Without it /metrics is not served. */
  metricsToken?: string;
  /** Applies pending migrations at startup, using HOOKMINT_DATABASE_ADMIN_URL. Off by default: run `npm run db:migrate` as a deploy step. */
  migrateOnStart?: { adminUrl: string; rolePasswords?: { app: string; worker: string } };
  shutdownGraceMs: number;
}

/**
 * Reads and checks the environment once, at startup. In production it refuses to start on settings that would be
 * unsafe: no API keys, no stable link-signing secret, or in-memory state (which loses every ad on restart).
 * It throws one error listing every problem, so a deploy fails once with the full list.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const production = env.HOOKMINT_ENV === "production";
  const num = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${name} must be a number from ${min} to ${max}.`);
      return fallback;
    }
    return n;
  };

  let apiKeys: ApiKeys | undefined;
  try {
    if (env.HOOKMINT_API_KEYS_FILE) apiKeys = ApiKeys.fromFile(env.HOOKMINT_API_KEYS_FILE);
    else if (env.HOOKMINT_API_KEYS) apiKeys = ApiKeys.fromJson(env.HOOKMINT_API_KEYS);
    else if (env.API_KEY) {
      if (production) problems.push("API_KEY (a plaintext key) is for development only. Use HOOKMINT_API_KEYS_FILE with hashed keys (npm run keys:new).");
      else apiKeys = ApiKeys.fromPlaintext(env.API_KEY, "acct_dev");
    }
  } catch (e) {
    problems.push(`API keys: ${e instanceof Error ? e.message : String(e)}`);
  }

  const corsOrigins = (env.HOOKMINT_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of corsOrigins) {
    if (o === "*") problems.push('HOOKMINT_CORS_ORIGINS must list exact origins, not "*".');
    else if (!/^https?:\/\/[^/\s]+$/.test(o)) problems.push(`HOOKMINT_CORS_ORIGINS entry "${o}" is not an origin like https://app.example.com.`);
  }

  const appUrl = env.HOOKMINT_DATABASE_URL?.trim();
  const workerUrl = env.HOOKMINT_DATABASE_WORKER_URL?.trim();
  let database: ServerConfig["database"];
  if (appUrl || workerUrl) {
    if (!appUrl || !workerUrl) problems.push("Set both HOOKMINT_DATABASE_URL (the hookmint_app role) and HOOKMINT_DATABASE_WORKER_URL (the hookmint_worker role), or neither.");
    else if (appUrl === workerUrl) problems.push("HOOKMINT_DATABASE_URL and HOOKMINT_DATABASE_WORKER_URL must use different roles. Using one for both would remove the separation between request handling and the work queue.");
    else if (!/^postgres(ql)?:\/\//.test(appUrl) || !/^postgres(ql)?:\/\//.test(workerUrl)) problems.push("Database URLs must start with postgres:// or postgresql://.");
    else database = { appUrl, workerUrl };
  }
  const adminUrl = env.HOOKMINT_DATABASE_ADMIN_URL?.trim();
  const appPw = env.HOOKMINT_APP_ROLE_PASSWORD?.trim();
  const workerPw = env.HOOKMINT_WORKER_ROLE_PASSWORD?.trim();
  if ((appPw || workerPw) && !(appPw && workerPw)) problems.push("Set both HOOKMINT_APP_ROLE_PASSWORD and HOOKMINT_WORKER_ROLE_PASSWORD, or neither.");
  else if (appPw && workerPw) {
    if (!/^[^\s]{16,200}$/.test(appPw) || !/^[^\s]{16,200}$/.test(workerPw)) problems.push("The role passwords must be 16 to 200 characters with no spaces.");
    if (appPw === workerPw) problems.push("The two role passwords must be different.");
    if (env.HOOKMINT_MIGRATE_ON_START !== "1") problems.push("HOOKMINT_APP_ROLE_PASSWORD and HOOKMINT_WORKER_ROLE_PASSWORD are applied at startup, which needs HOOKMINT_MIGRATE_ON_START=1 and HOOKMINT_DATABASE_ADMIN_URL.");
  }
  const migrateOnStart = env.HOOKMINT_MIGRATE_ON_START === "1" ? (adminUrl ? { adminUrl, ...(appPw && workerPw ? { rolePasswords: { app: appPw, worker: workerPw } } : {}) } : undefined) : undefined;
  if (env.HOOKMINT_MIGRATE_ON_START === "1" && !adminUrl) problems.push("HOOKMINT_MIGRATE_ON_START=1 needs HOOKMINT_DATABASE_ADMIN_URL.");

  let oauth: ServerConfig["oauth"];
  const issuer = env.HOOKMINT_OAUTH_ISSUER?.trim();
  if (issuer) {
    const publicUrl = env.HOOKMINT_PUBLIC_URL?.trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(issuer)) problems.push("HOOKMINT_OAUTH_ISSUER must be an https address, like https://your-tenant.example.com/.");
    if (!publicUrl || !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(publicUrl)) problems.push("OAuth needs HOOKMINT_PUBLIC_URL, this server's public https address (for example https://hookmint.example.com), because tokens are issued for it.");
    const claim = env.HOOKMINT_OAUTH_ACCOUNT_CLAIM?.trim() || undefined;
    if (claim && !/^[A-Za-z0-9_.:/-]{1,100}$/.test(claim)) problems.push("HOOKMINT_OAUTH_ACCOUNT_CLAIM is not a valid claim name.");
    const listed = (env.HOOKMINT_OAUTH_AUDIENCE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const defaults = (env.HOOKMINT_OAUTH_DEFAULT_SCOPES ?? "").split(/[\s,]+/).filter(Boolean);
    for (const s of defaults) {
      if (!(ALL_SCOPES as readonly string[]).includes(s)) problems.push(`HOOKMINT_OAUTH_DEFAULT_SCOPES has an unknown scope "${s}". Scopes: ${ALL_SCOPES.join(", ")}.`);
      if (s === "spend") problems.push('HOOKMINT_OAUTH_DEFAULT_SCOPES cannot include "spend": every invited account would be able to spend credits. Put spend in the tokens of the accounts that should have it.');
    }
    const spendAccounts = (env.HOOKMINT_OAUTH_SPEND_ACCOUNTS ?? "").split(/[\s,]+/).filter(Boolean);
    for (const a of spendAccounts) if (!/^[A-Za-z0-9_-]{1,64}$/.test(a)) problems.push(`HOOKMINT_OAUTH_SPEND_ACCOUNTS entry "${a}" is not a valid account id.`);
    const maxAge = num("HOOKMINT_OAUTH_MAX_TOKEN_AGE_S", 0, 0, 86_400);
    if (env.HOOKMINT_OAUTH_MAX_TOKEN_AGE_S && maxAge !== 0 && maxAge < 60) problems.push("HOOKMINT_OAUTH_MAX_TOKEN_AGE_S must be at least 60 seconds (or unset).");
    const skew = num("HOOKMINT_OAUTH_CLOCK_SKEW_S", 30, 0, 120);
    const algs = (env.HOOKMINT_OAUTH_ALGORITHMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const a of algs) if (!OAUTH_ALGORITHMS.includes(a)) problems.push(`HOOKMINT_OAUTH_ALGORITHMS lists "${a}", which is not an accepted asymmetric algorithm (${OAUTH_ALGORITHMS.join(", ")}).`);
    if (publicUrl) oauth = { issuer, audiences: listed.length ? listed : [`${publicUrl}/mcp`, publicUrl], resource: `${publicUrl}/mcp`, accountClaim: claim, ...(defaults.length ? { defaultScopes: defaults } : {}), ...(spendAccounts.length ? { spendAccounts } : {}), ...(maxAge >= 60 ? { maxTokenAgeS: maxAge } : {}), clockSkewS: skew, ...(algs.length ? { algorithms: algs } : {}) };
    if (production && !(maxAge >= 60)) warnings.push("OAuth is on but HOOKMINT_OAUTH_MAX_TOKEN_AGE_S is not set, so a leaked token works until its own expiry. Set it to a few minutes to limit that (tokens cannot be revoked once issued).");
  }

  // Remotion is free only for individuals and companies of up to three people. A larger company needs its own licence.
  const remotion = env.HOOKMINT_RENDERER?.trim() === "remotion";
  const licenceAck = env.HOOKMINT_REMOTION_LICENSE_ACK === "1";
  if (remotion && !licenceAck) {
    const msg = "HOOKMINT_RENDERER=remotion: Remotion is free only for individuals and companies of up to three people; larger companies need a paid licence (remotion.pro). After checking yours, set HOOKMINT_REMOTION_LICENSE_ACK=1.";
    if (production) problems.push(msg);
    else warnings.push(msg);
  }
  if (production && corsOrigins.length === 0) warnings.push("HOOKMINT_CORS_ORIGINS is empty, so browser-based clients on other websites cannot call this server (they fail without a clear error). Fine for server-to-server use; list exact origins if a web app needs access.");

  if (production) {
    if ((!apiKeys || apiKeys.size === 0) && !oauth) problems.push("Production needs API keys (HOOKMINT_API_KEYS_FILE) or OAuth (HOOKMINT_OAUTH_ISSUER). The server will not start open.");
    if (!env.HOOKMINT_URL_SECRET || env.HOOKMINT_URL_SECRET.length < 32) problems.push("Production needs HOOKMINT_URL_SECRET of at least 32 characters, so download links survive a restart.");
    if (!database && env.HOOKMINT_ALLOW_EPHEMERAL !== "1") {
      problems.push("State is held in memory and is lost on restart. Set HOOKMINT_DATABASE_URL and HOOKMINT_DATABASE_WORKER_URL (see docs/DATABASE.md). To run a demo anyway, set HOOKMINT_ALLOW_EPHEMERAL=1.");
    }
  }

  const metricsToken = env.HOOKMINT_METRICS_TOKEN?.trim() || undefined;
  if (metricsToken && metricsToken.length < 24) problems.push("HOOKMINT_METRICS_TOKEN must be at least 24 characters. Make one with: openssl rand -hex 24");
  const config: ServerConfig = {
    metricsToken,
    port: num("PORT", 3000, 0, 65535),
    production,
    apiKeys,
    oauth,
    corsOrigins,
    maxBodyBytes: num("HOOKMINT_MAX_BODY_BYTES", DEFAULT_MAX_BODY, 1024, 50_000_000),
    logLevel: levelFromEnv(env.HOOKMINT_LOG_LEVEL),
    hsts: env.HOOKMINT_HSTS === "1",
    database,
    migrateOnStart,
    warnings,
    initialCredits: num("INITIAL_CREDITS", 1000, 0, 10_000_000),
    shutdownGraceMs: num("HOOKMINT_SHUTDOWN_GRACE_MS", 25_000, 0, 600_000),
  };
  if (problems.length) throw new Error(`Hookmint cannot start:\n- ${problems.join("\n- ")}`);
  return config;
}
