import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who and what a piece of work belongs to, carried across awaits so logs line up: the HTTP request that started it,
 * the account, and (in background handlers) the ad. A request id is written into queued work, so a script or render that
 * runs later on another instance logs the id of the request that asked for it.
 */
export interface RequestContext {
  requestId?: string;
  accountId?: string;
  jobId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();
/** Adds to the current context in place, so work already started under it (everything awaited later) sees the addition. */
export const annotate = (extra: RequestContext): void => {
  const s = store.getStore();
  if (s) Object.assign(s, extra);
};
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => store.run({ ...store.getStore(), ...ctx }, fn);
export const currentContext = (): RequestContext => store.getStore() ?? {};

/** The context as log fields, named like the rest of the logs (snake_case), left out when empty. */
export function logFields(): Record<string, string> {
  const c = store.getStore() ?? {};
  return { ...(c.requestId ? { request_id: c.requestId } : {}), ...(c.accountId ? { account_id: c.accountId } : {}), ...(c.jobId ? { job_id: c.jobId } : {}) };
}
