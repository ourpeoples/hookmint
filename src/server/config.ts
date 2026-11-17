import { levelFromEnv, type Level } from "../core/logger.js";
import { ApiKeys } from "./api-keys.js";
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
  shutdownGraceMs: number;
}

/**
 * Reads and checks the environment once, at startup. In production it refuses to start on settings that would be
 * unsafe: no API keys, no stable link-signing secret, or in-memory state (which loses every ad on restart).
 * It throws one error listing every problem, so a deploy fails once with the full list.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const problems: string[] = [];
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

  if (production) {
    if (!apiKeys || apiKeys.size === 0) problems.push("Production needs API keys: set HOOKMINT_API_KEYS_FILE. The server will not start open.");
    if (!env.HOOKMINT_URL_SECRET || env.HOOKMINT_URL_SECRET.length < 32) problems.push("Production needs HOOKMINT_URL_SECRET of at least 32 characters, so download links survive a restart.");
    if (env.HOOKMINT_ALLOW_EPHEMERAL !== "1") {
      problems.push("State is held in memory and is lost on restart. Production needs the database store, which is not built yet. To run a demo anyway, set HOOKMINT_ALLOW_EPHEMERAL=1.");
    }
  }

  const config: ServerConfig = {
    port: num("PORT", 3000, 0, 65535),
    production,
    apiKeys,
    corsOrigins,
    maxBodyBytes: num("HOOKMINT_MAX_BODY_BYTES", DEFAULT_MAX_BODY, 1024, 50_000_000),
    logLevel: levelFromEnv(env.HOOKMINT_LOG_LEVEL),
    hsts: env.HOOKMINT_HSTS === "1",
    initialCredits: num("INITIAL_CREDITS", 1000, 0, 10_000_000),
    shutdownGraceMs: num("HOOKMINT_SHUTDOWN_GRACE_MS", 25_000, 0, 600_000),
  };
  if (problems.length) throw new Error(`Hookmint cannot start:\n- ${problems.join("\n- ")}`);
  return config;
}
