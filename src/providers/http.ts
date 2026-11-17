import { AdError } from "../core/errors.js";

export interface ProviderHttp {
  /** Shown in error messages, e.g. "Pexels". */
  name: string;
  /** The environment variable that holds the key, named in the "check your key" message. */
  keyVar: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Largest response body accepted. */
  maxBytes: number;
  now?: () => number;
}

export interface ProviderReply {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

/**
 * One request to a fixed provider API. Redirects are refused (the key would travel with them), the body is read
 * with a size cap, and error messages carry only the status and the request id, never the key or the request.
 */
export async function providerRequest(cfg: ProviderHttp, url: string, init: RequestInit): Promise<ProviderReply> {
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await (cfg.fetch ?? fetch)(url, { ...init, redirect: "error", signal: ctrl.signal });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new AdError("provider_unavailable", timedOut ? `${cfg.name} did not answer within ${Math.round(timeoutMs / 1000)}s.` : `Could not reach ${cfg.name}.`);
    }
    const id = res.headers.get("x-request-id") ?? res.headers.get("x-pexels-request-id") ?? undefined;
    const tag = id ? ` (request ${id.slice(0, 64)})` : "";
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw httpError(cfg, res, tag);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > cfg.maxBytes) throw new AdError("provider_unavailable", `${cfg.name} sent a response larger than ${cfg.maxBytes} bytes${tag}.`, undefined, { retry: false });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of res.body ?? []) {
        size += (c as Uint8Array).length;
        if (size > cfg.maxBytes) {
          ctrl.abort();
          throw new AdError("provider_unavailable", `${cfg.name} sent a response larger than ${cfg.maxBytes} bytes${tag}.`, undefined, { retry: false });
        }
        chunks.push(Buffer.from(c as Uint8Array));
      }
    } catch (err) {
      if (err instanceof AdError) throw err;
      throw new AdError("provider_unavailable", `${cfg.name} stopped sending the response${tag}.`);
    }
    return { status: res.status, headers: res.headers, bytes: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson(cfg: ProviderHttp, reply: ProviderReply): unknown {
  try {
    return JSON.parse(reply.bytes.toString("utf8"));
  } catch {
    throw new AdError("provider_unavailable", `${cfg.name} returned an unreadable answer.`);
  }
}

function httpError(cfg: ProviderHttp, res: Response, tag: string): AdError {
  const s = res.status;
  if (s === 401 || s === 403) return new AdError("provider_unavailable", `${cfg.name} rejected the API key${tag}. Check ${cfg.keyVar}.`, undefined, { retry: false });
  if (s === 429) {
    const now = (cfg.now ?? Date.now)();
    const after = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset")); // Pexels: a unix time in seconds
    const wait = Number.isFinite(after) && after > 0 ? after : Number.isFinite(reset) && reset * 1000 > now ? Math.ceil(reset - now / 1000) : undefined;
    // A wait of a few seconds is worth retrying. A quota that resets in an hour is not: retrying would only burn attempts.
    return new AdError("rate_limited", `${cfg.name} rate limit was hit${tag}.`, wait, { retry: wait !== undefined && wait <= 30 });
  }
  if (s === 400 || s === 404 || s === 413 || s === 422) return new AdError("invalid_input", `${cfg.name} rejected the request${tag} (status ${s}).`, undefined, { retry: false });
  return new AdError("provider_unavailable", `${cfg.name} is unavailable${tag} (status ${s}).`);
}
