import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { ALL_SCOPES, type Ctx } from "../core/context.js";

/**
 * API keys are stored only as SHA-256 digests, so a leaked config file or memory dump does not reveal a usable
 * key. Each key has its own account, optional scope limits, an optional expiry, and can be revoked. An account can
 * hold several keys at once, which is how a key is rotated: add the new one, move clients over, revoke the old one.
 */
export interface KeyRecord {
  id: string;
  /** SHA-256 of the token, as 64 hex characters. */
  sha256: string;
  account_id: string;
  /** Defaults to every scope. */
  scopes?: string[];
  label?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
}

export type AuthResult = { ok: true; ctx: Ctx; keyId: string } | { ok: false; reason: "unknown" | "expired" | "revoked"; keyId?: string };

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

export class ApiKeys {
  private byHash = new Map<string, KeyRecord>();
  readonly lastUsed = new Map<string, number>();

  constructor(records: KeyRecord[], private now: () => number = Date.now) {
    const ids = new Set<string>();
    for (const r of records) {
      ApiKeys.validate(r);
      if (ids.has(r.id)) throw new Error(`API key id "${r.id}" appears twice.`);
      if (this.byHash.has(r.sha256)) throw new Error(`API key "${r.id}" has the same digest as another key.`);
      ids.add(r.id);
      this.byHash.set(r.sha256, r);
    }
  }

  static validate(r: KeyRecord): void {
    const where = `API key "${r?.id ?? "?"}"`;
    if (!r?.id || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.id)) throw new Error(`${where}: id must be 1 to 64 letters, digits, dots, dashes or underscores.`);
    if (!HEX64.test(r.sha256 ?? "")) throw new Error(`${where}: sha256 must be the 64-character hex digest of the key, never the key itself. Use "npm run keys:new" to make one.`);
    if (!r.account_id || !/^[A-Za-z0-9_-]{1,64}$/.test(r.account_id)) throw new Error(`${where}: account_id must be 1 to 64 letters, digits, dashes or underscores.`);
    for (const s of r.scopes ?? []) if (!(ALL_SCOPES as readonly string[]).includes(s)) throw new Error(`${where}: unknown scope "${s}". Scopes: ${ALL_SCOPES.join(", ")}.`);
    for (const f of ["created_at", "expires_at", "revoked_at"] as const) {
      if (r[f] !== undefined && Number.isNaN(Date.parse(r[f]!))) throw new Error(`${where}: ${f} is not a valid date.`);
    }
  }

  /** A new random key, returned once with its record. Only the digest is meant to be stored. */
  static generate(account_id: string, opts: { label?: string; scopes?: string[]; expires_at?: string } = {}, now = new Date()): { token: string; record: KeyRecord } {
    const token = `hmk_${randomBytes(32).toString("base64url")}`;
    const record: KeyRecord = { id: `key_${randomBytes(6).toString("hex")}`, sha256: sha256(token), account_id, created_at: now.toISOString(), ...opts };
    ApiKeys.validate(record);
    return { token, record };
  }

  /** For a single plaintext key from the environment (development). Production should use stored digests. */
  static fromPlaintext(token: string, account_id: string, id = "dev"): ApiKeys {
    return new ApiKeys([{ id, sha256: sha256(token), account_id }]);
  }

  /** Adapter for tests and embedders that hold token -> context pairs. */
  static fromMap(m: Map<string, Ctx>): ApiKeys {
    return new ApiKeys([...m].map(([token, ctx], i) => ({ id: `map_${i}`, sha256: sha256(token), account_id: ctx.accountId, scopes: [...ctx.scopes] })));
  }

  static fromJson(json: string, now?: () => number): ApiKeys {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("The API keys file is not valid JSON. It should be an array of key records.");
    }
    if (!Array.isArray(parsed)) throw new Error("The API keys file should be an array of key records.");
    return new ApiKeys(parsed as KeyRecord[], now);
  }

  static fromFile(path: string, now?: () => number): ApiKeys {
    return ApiKeys.fromJson(readFileSync(path, "utf8"), now);
  }

  accountIds(): string[] {
    return [...new Set([...this.byHash.values()].map((r) => r.account_id))];
  }

  get size(): number {
    return this.byHash.size;
  }

  authenticate(token: string): AuthResult {
    if (!token || token.length > 512) return { ok: false, reason: "unknown" };
    const digest = sha256(token);
    const rec = this.byHash.get(digest);
    // The lookup is by digest, so nothing about the token itself decides how long it takes. The comparison below
    // is constant-time anyway, so the property does not rest on how the map is implemented.
    if (!rec || !timingSafeEqual(Buffer.from(digest), Buffer.from(rec.sha256))) return { ok: false, reason: "unknown" };
    const now = this.now();
    if (rec.revoked_at && Date.parse(rec.revoked_at) <= now) return { ok: false, reason: "revoked", keyId: rec.id };
    if (rec.expires_at && Date.parse(rec.expires_at) <= now) return { ok: false, reason: "expired", keyId: rec.id };
    this.lastUsed.set(rec.id, now);
    return { ok: true, keyId: rec.id, ctx: { accountId: rec.account_id, scopes: new Set(rec.scopes ?? ALL_SCOPES) } };
  }

  /** Marks a key revoked from now on. */
  revoke(id: string): boolean {
    for (const r of this.byHash.values()) if (r.id === id) { r.revoked_at = new Date(this.now()).toISOString(); return true; }
    return false;
  }
}

/** Pulls the token out of an Authorization header. The scheme is case-insensitive; anything else is rejected. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer[ \t]+([^\s]+)$/i.exec(header ?? "");
  return m?.[1];
}
