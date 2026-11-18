import { AdError } from "./errors.js";
import { DAY, type FetchQuotaLike, type Limits, waitText } from "./limits.js";
import type { Store } from "./store.js";

/**
 * The daily download allowance (how many downloads, how many bytes), kept in the store so every instance shares it.
 * Same rules and wording as the in-process FetchQuota: each attempt counts at once, so a burst cannot slip under the
 * count; the size is added when the download finishes, so one file may take an account slightly over its byte allowance.
 */
export class StoreFetchQuota implements FetchQuotaLike {
  constructor(private store: Store, private limits: Pick<Limits, "fetchesPerDay" | "fetchBytesPerDay">, private now: () => number = Date.now) {}

  async before(accountId: string): Promise<void> {
    const now = this.now();
    await this.store.tx(accountId, async (t) => {
      await t.lockKey("rate:fetch"); // one at a time per account across all instances
      const count = await t.rateEvents("fetches", DAY, now);
      const bytes = await t.rateEvents("fetch_bytes", DAY, now);
      const wait = (events: { t: number }[]) => Math.max(1, Math.ceil(((events[0]?.t ?? now) + DAY - now) / 1000));
      if (count.length >= this.limits.fetchesPerDay) {
        const s = wait(count);
        throw new AdError("rate_limited", `This account has reached its limit of ${this.limits.fetchesPerDay} downloads a day. Try again in ${waitText(s)}.`, s, { retry: false });
      }
      if (bytes.reduce((n, e) => n + (e as { w: number }).w, 0) >= this.limits.fetchBytesPerDay) {
        const s = wait(bytes);
        throw new AdError("rate_limited", `This account has reached its daily download size limit. Try again in ${waitText(s)}.`, s, { retry: false });
      }
      await t.recordRate("fetches", 1, now);
    });
  }

  async after(accountId: string, bytes: number): Promise<void> {
    await this.store.tx(accountId, (t) => t.recordRate("fetch_bytes", bytes, this.now()));
  }
}
