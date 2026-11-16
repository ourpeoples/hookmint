import { AdError } from "./errors.js";

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

/**
 * Runs each provider call at most once per key. A repeat (retry, queue redelivery, crash recovery)
 * returns the stored result, and concurrent callers share one in-flight call, so nothing is paid twice.
 * Transient errors (provider_unavailable) retry with exponential backoff and jitter.
 */
export class ProviderCalls {
  private records = new Map<string, ProviderCallRecord>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private retryBaseMs = 200, private maxAttempts = 3) {}

  get(key: string) {
    return this.records.get(key);
  }

  count(status: ProviderCallRecord["status"]) {
    return [...this.records.values()].filter((r) => r.status === status).length;
  }

  runOnce<T>(key: string, meta: { provider: string; cost_credits: number }, fn: () => Promise<T>): Promise<T> {
    const done = this.records.get(key);
    if (done?.status === "done") return Promise.resolve(done.result as T);
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const rec: ProviderCallRecord = { call_key: key, ...meta, status: "started", attempts: 0 };
    this.records.set(key, rec);
    const started = Date.now();
    const p = (async () => {
      try {
        for (let attempt = 1; ; attempt++) {
          rec.attempts = attempt;
          try {
            const result = await fn();
            rec.status = "done";
            rec.result = result;
            rec.latency_ms = Date.now() - started;
            return result;
          } catch (err) {
            const retryable = err instanceof AdError && err.code === "provider_unavailable";
            if (!retryable || attempt >= this.maxAttempts) throw err;
            await sleep(this.retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5));
          }
        }
      } catch (err) {
        rec.status = "failed";
        rec.error_class = err instanceof AdError ? err.code : "unexpected";
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
