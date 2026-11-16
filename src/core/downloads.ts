import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SignedLink {
  url: string;
  expires_at: string;
  ttl_s: number;
}

export type Verdict = "ok" | "expired" | "invalid";

/**
 * Short-lived, signed download links for finished videos. A link names one render for one account and stops
 * working at its expiry, so a leaked link exposes an unreleased ad for minutes, not days. Fresh links come from
 * the get_download_url tool.
 */
export class DownloadSigner {
  private secret: Buffer;
  readonly ttlSeconds: number;
  readonly baseUrl: string;
  /** True when the secret was generated for this process: links stop working after a restart. */
  readonly ephemeral: boolean;

  constructor(opts: { secret?: string; baseUrl?: string; ttlSeconds?: number } = {}) {
    if (opts.secret !== undefined && opts.secret.length < 32) throw new Error("HOOKMINT_URL_SECRET must be at least 32 characters");
    this.ephemeral = opts.secret === undefined;
    this.secret = Buffer.from(opts.secret ?? randomBytes(32).toString("hex"));
    this.ttlSeconds = opts.ttlSeconds ?? 15 * 60;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  }

  private mac(renderId: string, accountId: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`v1.${renderId}.${accountId}.${exp}`).digest("base64url");
  }

  sign(accountId: string, renderId: string, nowMs = Date.now()): SignedLink {
    const exp = Math.floor(nowMs / 1000) + this.ttlSeconds;
    const q = new URLSearchParams({ acct: accountId, exp: String(exp), sig: this.mac(renderId, accountId, exp) });
    return { url: `${this.baseUrl}/files/${encodeURIComponent(renderId)}?${q}`, expires_at: new Date(exp * 1000).toISOString(), ttl_s: this.ttlSeconds };
  }

  verify(p: { renderId: string; acct: string | null; exp: string | null; sig: string | null }, nowMs = Date.now()): Verdict {
    if (!p.acct || !p.exp || !p.sig || !/^\d{1,12}$/.test(p.exp)) return "invalid";
    const given = Buffer.from(p.sig);
    const want = Buffer.from(this.mac(p.renderId, p.acct, Number(p.exp)));
    if (given.length !== want.length || !timingSafeEqual(given, want)) return "invalid";
    return Number(p.exp) * 1000 > nowMs ? "ok" : "expired";
  }
}
