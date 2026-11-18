import { z } from "zod";
import { AdError } from "./errors.js";

/**
 * Per-account limits. They bound cost (model calls, renders), abuse (making the server download files), and
 * fairness (one account cannot fill the render queue). Everything here is a starting value to tune with real use.
 * Counters live in memory, so with more than one server instance each instance counts separately until they
 * share a store (Redis), which belongs with the rest of the persistence work.
 */
export interface Limits {
  /** Any tool call or REST request, per account. */
  requestsPerMinute: number;
  createAdPerHour: number;
  /** Counted by the number of variants asked for, because each one is a model-written alternative. */
  createVariantsPerHour: number;
  createBrandKitPerHour: number;
  setBrandRulesPerHour: number;
  /** approve_and_render and a confirmed regenerate_scene. */
  spendActionsPerHour: number;
  /** Videos being generated or rendered at once, per account. */
  maxActiveJobs: number;
  /** Logos still downloading, per account. */
  maxPendingLogos: number;
  fetchesPerDay: number;
  fetchBytesPerDay: number;
  /** link_ad: tying a finished ad to a live ad on a platform. */
  linkAdPerHour: number;
  /** record_performance calls (each may carry many days of numbers). */
  recordPerformancePerHour: number;
  /** Bad API keys or bad download signatures from one network address. Valid requests are never blocked by this. */
  authFailuresPer10Min: number;
}

export const DEFAULT_LIMITS: Limits = {
  requestsPerMinute: 300,
  createAdPerHour: 20,
  createVariantsPerHour: 20,
  createBrandKitPerHour: 20,
  setBrandRulesPerHour: 60,
  spendActionsPerHour: 60,
  maxActiveJobs: 3,
  maxPendingLogos: 5,
  fetchesPerDay: 300,
  fetchBytesPerDay: 1024 * 1024 * 1024,
  linkAdPerHour: 60,
  recordPerformancePerHour: 300,
  authFailuresPer10Min: 30,
};

const positiveInt = z.number().int().min(1).max(1e12);
const LimitsSchema = z.object(Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, positiveInt.optional()]))).strict();

/** Reads HOOKMINT_LIMITS, a JSON object overriding any of the defaults. A mistake stops startup with a clear message. */
export function parseLimits(raw: string | undefined): Limits {
  if (!raw?.trim()) return { ...DEFAULT_LIMITS };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("HOOKMINT_LIMITS must be a JSON object, for example {\"createAdPerHour\": 10}.");
  }
  const parsed = LimitsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`HOOKMINT_LIMITS is not valid: ${parsed.error.issues.map((i) => (i.code === "unrecognized_keys" ? `unknown setting ${i.keys.join(", ")}` : `${i.path.join(".")} must be a whole number of at least 1`)).join("; ")}. Settings: ${Object.keys(DEFAULT_LIMITS).join(", ")}.`);
  }
  return { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) } as Limits;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "40 seconds", "12 minutes", "3 hours": a plain wait time for messages. */
export function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

const windowText = (ms: number) => (ms >= DAY ? "day" : ms >= HOUR ? "hour" : ms >= MINUTE * 10 ? `${ms / MINUTE} minutes` : "minute");

interface Event {
  t: number;
  w: number;
}

/** Sliding-window counter. `take` records the use only if it fits, so a refused request does not extend the wait. */
export class RateLimiter {
  private events = new Map<string, Event[]>();

  constructor(private now: () => number = Date.now) {}

  take(scope: string, key: string, limit: number, windowMs: number, opts: { weight?: number; label: string }): void {
    const weight = opts.weight ?? 1;
    if (weight > limit) throw new AdError("invalid_input", `That asks for more than the limit of ${limit} ${opts.label} per ${windowText(windowMs)}. Ask for fewer.`);
    const id = `${scope}\u0000${key}`;
    const now = this.now();
    const live = (this.events.get(id) ?? []).filter((e) => e.t > now - windowMs);
    let used = live.reduce((n, e) => n + e.w, 0);
    if (used + weight > limit) {
      // Wait until enough of the oldest uses fall out of the window to make room.
      let freed = 0;
      let until = now + windowMs;
      for (const e of live) {
        freed += e.w;
        if (used - freed + weight <= limit) { until = e.t + windowMs; break; }
      }
      const seconds = Math.max(1, Math.ceil((until - now) / 1000));
      this.events.set(id, live);
      throw new AdError("rate_limited", `You have used all ${limit} ${opts.label} allowed per ${windowText(windowMs)}. Try again in ${waitText(seconds)}.`, seconds, { retry: false });
    }
    used += weight;
    live.push({ t: now, w: weight });
    this.events.set(id, live);
    if (this.events.size > 50_000) this.sweep(now, windowMs); // keep memory bounded when many accounts have come and gone
  }

  /** How many entries are being tracked. For tests and monitoring. */
  size(): number {
    return this.events.size;
  }

  private sweep(now: number, windowMs: number) {
    for (const [k, v] of this.events) if (!v.some((e) => e.t > now - windowMs)) this.events.delete(k);
  }
}

/**
 * Daily allowance for downloads an account causes: how many, and how many bytes. Checked before each download
 * and updated after it, so one file may take an account slightly over its byte allowance, never more than that.
 */
export class FetchQuota {
  private log = new Map<string, { t: number; bytes: number }[]>();

  constructor(private limits: Pick<Limits, "fetchesPerDay" | "fetchBytesPerDay">, private now: () => number = Date.now) {}

  private live(accountId: string) {
    const cutoff = this.now() - DAY;
    const live = (this.log.get(accountId) ?? []).filter((e) => e.t > cutoff);
    this.log.set(accountId, live);
    return live;
  }

  before(accountId: string): void {
    const live = this.live(accountId);
    const retry = (field: "t") => Math.max(1, Math.ceil((live[0][field] + DAY - this.now()) / 1000));
    if (live.length >= this.limits.fetchesPerDay) {
      const s = retry("t");
      throw new AdError("rate_limited", `This account has reached its limit of ${this.limits.fetchesPerDay} downloads a day. Try again in ${waitText(s)}.`, s, { retry: false });
    }
    if (live.reduce((n, e) => n + e.bytes, 0) >= this.limits.fetchBytesPerDay) {
      const s = retry("t");
      throw new AdError("rate_limited", `This account has reached its daily download size limit. Try again in ${waitText(s)}.`, s, { retry: false });
    }
    // Count the attempt now, so a burst of parallel downloads cannot all slip under the count check.
    live.push({ t: this.now(), bytes: 0 });
  }

  /** Records how large the finished download was. */
  after(accountId: string, bytes: number): void {
    const live = this.live(accountId);
    const last = [...live].reverse().find((e) => e.bytes === 0);
    if (last) last.bytes = bytes;
  }
}

/**
 * Counts failed credential checks per network address. It only ever refuses requests that have ALREADY failed
 * their check, so a valid key or a valid download link is never locked out by someone else's guessing, even when
 * many clients share one address behind a proxy.
 */
export class FailureLimiter {
  private fails = new Map<string, number[]>();

  constructor(private limit: number, private windowMs = 10 * MINUTE, private now: () => number = Date.now) {}

  /** Call for a request whose credentials were wrong. Throws once the address has failed too often. */
  failed(address: string): void {
    const now = this.now();
    const live = (this.fails.get(address) ?? []).filter((t) => t > now - this.windowMs);
    live.push(now);
    this.fails.set(address, live);
    if (live.length > this.limit) {
      const seconds = Math.max(1, Math.ceil((live[0] + this.windowMs - now) / 1000));
      throw new AdError("rate_limited", `Too many failed attempts. Try again in ${waitText(seconds)}.`, seconds, { retry: false });
    }
    if (this.fails.size > 50_000) for (const [k, v] of this.fails) if (!v.some((t) => t > now - this.windowMs)) this.fails.delete(k);
  }
}
