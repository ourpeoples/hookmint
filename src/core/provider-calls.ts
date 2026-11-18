import { AdError } from "./errors.js";
import { metrics } from "./metrics.js";

export interface ProviderCallRecord {
  call_key: string;
  provider: string;
  status: "started" | "done" | "failed";
  result?: unknown;
  cost_credits: number;
  latency_ms?: number;
  error_class?: string;
  attempts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProviderCallOptions {
  /** Longest one attempt may take before it counts as a provider failure. */
  timeoutMs?: number;
  /** Consecutive failures that open a provider's breaker. */
  breakerThreshold?: number;
  /** How long an open breaker refuses calls before letting one probe through. */
  breakerCooldownMs?: number;
  now?: () => number;
  /** Where finished calls are kept beyond this process. With it, a retry after a restart does not pay twice. */
  persist?: {
    load(key: string): Promise<ProviderCallRecord | undefined>;
    save(rec: ProviderCallRecord): Promise<void>;
  };
}

interface Breaker {
  failures: number;
  openedAt?: number;
  probing?: boolean;
}

/**
 * Runs each provider call at most once per key. A repeat (retry, queue redelivery, crash recovery)
 * returns the stored result, and concurrent callers share one in-flight call, so nothing is paid twice.
 * Transient errors (provider_unavailable, rate_limited) retry with exponential backoff and jitter,
 * waiting at least as long as the provider's retry_after (capped at 30 seconds).
 */
export class ProviderCalls {
  private records = new Map<string, ProviderCallRecord>();
  private inflight = new Map<string, Promise<unknown>>();

  private breakers = new Map<string, Breaker>();
  private readonly timeoutMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly persist?: ProviderCallOptions["persist"];

  constructor(private retryBaseMs = 200, private maxAttempts = 3, opts: ProviderCallOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.threshold = opts.breakerThreshold ?? 5;
    this.cooldownMs = opts.breakerCooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist;
  }

  /** "closed" lets calls through, "open" refuses them, "half-open" is letting one probe through. */
  breakerState(provider: string): "closed" | "open" | "half-open" {
    const b = this.breakers.get(provider);
    if (!b || b.openedAt === undefined) return "closed";
    return this.now() - b.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  /** Every provider this process has called, for the metrics scrape. */
  providers(): string[] {
    return [...this.breakers.keys()];
  }

  /** Providers whose breaker is open right now, for the readiness report. */
  openBreakers(): string[] {
    return [...this.breakers.keys()].filter((p) => this.breakerState(p) === "open");
  }

  private admitBreaker(provider: string): void {
    const state = this.breakerState(provider);
    if (state === "closed") return;
    const b = this.breakers.get(provider)!;
    if (state === "open" || b.probing) {
      metrics.providerCalls.inc({ provider, outcome: "refused_by_breaker" });
      const wait = Math.max(1, Math.ceil((this.cooldownMs - (this.now() - (b.openedAt ?? 0))) / 1000));
      throw new AdError("provider_unavailable", `${provider} is failing repeatedly, so calls to it are paused for a short while.`, wait, { retry: false });
    }
    b.probing = true; // half-open: exactly one call tests the provider
  }

  private recordOutcome(provider: string, err: unknown): void {
    const b = this.breakers.get(provider) ?? { failures: 0 };
    this.breakers.set(provider, b);
    b.probing = false;
    // Only the provider's own trouble counts. A bad request or one of our limits says nothing about its health.
    const providerFault = err !== undefined && (!(err instanceof AdError) || (err.retry && (err.code === "provider_unavailable" || err.code === "rate_limited")));
    if (err === undefined) {
      b.failures = 0;
      b.openedAt = undefined;
    } else if (providerFault) {
      b.failures++;
      if (b.failures >= this.threshold) b.openedAt = this.now();
    }
    metrics.breakerOpen.set({ provider }, b.openedAt !== undefined ? 1 : 0);
  }

  private withDeadline<T>(provider: string, fn: () => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AdError("provider_unavailable", `${provider} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    });
    return Promise.race([fn(), deadline]).finally(() => clearTimeout(timer));
  }

  get(key: string) {
    return this.records.get(key);
  }

  count(status: ProviderCallRecord["status"]) {
    return [...this.records.values()].filter((r) => r.status === status).length;
  }

  runOnce<T>(key: string, meta: { provider: string; cost_credits: number; timeoutMs?: number }, fn: () => Promise<T>): Promise<T> {
    const done = this.records.get(key);
    if (done?.status === "done") {
      metrics.providerCalls.inc({ provider: meta.provider, outcome: "reused" });
      return Promise.resolve(done.result as T);
    }
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const { timeoutMs: callTimeout, ...recMeta } = meta;
    const rec: ProviderCallRecord = { call_key: key, ...recMeta, status: "started", attempts: 0 };
    this.records.set(key, rec);
    const started = Date.now();
    const p = (async () => {
      try {
        const kept = await this.persist?.load(key).catch(() => undefined);
        if (kept?.status === "done") {
          Object.assign(rec, kept);
          metrics.providerCalls.inc({ provider: meta.provider, outcome: "reused" });
          return kept.result as T;
        }
        for (let attempt = 1; ; attempt++) {
          rec.attempts = attempt;
          this.admitBreaker(meta.provider); // refused calls are not attempts and never count against the provider
          try {
            const result = await this.withDeadline(meta.provider, fn, callTimeout);
            this.recordOutcome(meta.provider, undefined);
            rec.status = "done";
            rec.result = result;
            rec.latency_ms = Date.now() - started;
            metrics.providerCalls.inc({ provider: meta.provider, outcome: "ok" });
            metrics.providerDuration.observe({ provider: meta.provider }, (Date.now() - started) / 1000);
            metrics.providerCredits.inc({ provider: meta.provider }, meta.cost_credits);
            await this.persist?.save(rec).catch(() => undefined); // failing to remember is not failing the call
            return result;
          } catch (err) {
            // Every failed attempt is counted, so a provider that is failing shows up even when a retry or the breaker ends the call.
            metrics.providerCalls.inc({ provider: meta.provider, outcome: "error" });
            metrics.providerErrors.inc({ provider: meta.provider, code: err instanceof AdError ? err.code : "unexpected" });
            this.recordOutcome(meta.provider, err);
            const retryable = err instanceof AdError && err.retry && (err.code === "provider_unavailable" || err.code === "rate_limited");
            if (!retryable || attempt >= this.maxAttempts) throw err;
            const backoff = this.retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
            const asked = err.retry_after !== undefined ? Math.min(err.retry_after, 30) * 1000 : 0;
            await sleep(Math.max(backoff, asked));
          }
        }
      } catch (err) {
        rec.status = "failed";
        rec.error_class = err instanceof AdError ? err.code : "unexpected";
        const refused = err instanceof AdError && err.message.includes("calls to it are paused"); // already counted as refused_by_breaker
        if (!refused) metrics.providerDuration.observe({ provider: meta.provider }, (Date.now() - started) / 1000);
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
