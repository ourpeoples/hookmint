import dns from "node:dns";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { AdError } from "../core/errors.js";
import { isBlockedHostname, isPublicAddress } from "./address.js";

export interface FetchLimits {
  maxBytes: number;
  /** Accepted media types, matched exactly after stripping parameters, e.g. ["image/png", "image/jpeg"]. */
  accept: string[];
  /** Whole-request deadline including redirects. Default 15 s. */
  timeoutMs?: number;
  /** Default 3. */
  maxRedirects?: number;
}

export interface Fetched {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

export interface Resolved {
  address: string;
  family: number;
}

export interface SafeFetcherOptions {
  /** Default: the system resolver, all addresses. */
  resolve?: (host: string) => Promise<Resolved[]>;
  /** Tests only: replaces https.request. */
  request?: typeof https.request;
  /** Tests only: allows private addresses, reserved names and extra ports so a local server can be used. Never set from config. */
  allowPrivateNetworks?: boolean;
  /** Tests only: extra trusted CA, for a local server's certificate. */
  ca?: string | Buffer;
  /** Default [443]. */
  allowedPorts?: number[];
}

const reject = (msg: string): never => {
  throw new AdError("invalid_input", msg);
};

/**
 * Fetches a URL on behalf of a user without letting that user reach anything internal (SSRF).
 *
 * - https only, no credentials in the URL, port 443.
 * - The name is resolved here, every address must be public, and the connection is then made to that exact
 *   address ("pinned"), so DNS cannot change its answer between the check and the connection (DNS rebinding).
 *   Certificate checks and SNI still use the original hostname.
 * - Redirects are followed by hand, at most a few, and every hop goes through all of the checks again.
 * - Hard limits on time, size and media type; no compressed bodies; no cookies, credentials or referer sent.
 *
 * It uses no proxy from the environment: a proxy would see the hostname, not the address we validated.
 */
export class SafeFetcher {
  private resolve: (host: string) => Promise<Resolved[]>;
  private request: typeof https.request;
  private priv: boolean;
  private ca?: string | Buffer;
  private ports: number[];

  constructor(opts: SafeFetcherOptions = {}) {
    this.resolve = opts.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
    this.request = opts.request ?? https.request;
    this.priv = opts.allowPrivateNetworks ?? false;
    this.ca = opts.ca;
    this.ports = opts.allowedPorts ?? [443];
  }

  /** The checks that need no network. Use it to refuse a bad URL immediately, before queueing any work. */
  checkUrl(input: string): URL {
    let u: URL;
    try {
      u = new URL(input);
    } catch {
      return reject("That is not a valid web address.");
    }
    if (u.protocol !== "https:") reject("Only https:// addresses are allowed.");
    if (u.username || u.password) reject("Addresses with a username or password are not allowed.");
    const port = u.port ? Number(u.port) : 443;
    if (!this.priv && !this.ports.includes(port)) reject("Only the standard https port is allowed.");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
      if (!this.priv && !isPublicAddress(host)) reject("That address points to a private or internal network, which is not allowed.");
    } else if (!this.priv && isBlockedHostname(host)) {
      reject("That address points to a private or internal network, which is not allowed.");
    }
    return u;
  }

  private async pick(u: URL): Promise<Resolved[]> {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
    let addrs: Resolved[];
    try {
      addrs = await this.resolve(host);
    } catch {
      return reject("That address could not be looked up.");
    }
    if (!addrs.length) reject("That address could not be looked up.");
    // Every address must be public. One private answer is enough to refuse: a later connection could choose it.
    if (!this.priv && addrs.some((a) => !isPublicAddress(a.address))) reject("That address points to a private or internal network, which is not allowed.");
    return addrs;
  }

  async get(input: string, limits: FetchLimits): Promise<Fetched> {
    const deadline = Date.now() + (limits.timeoutMs ?? 15_000);
    const maxRedirects = limits.maxRedirects ?? 3;
    let url = input;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = this.checkUrl(url);
      const addrs = await this.pick(u);
      const res = await this.once(u, addrs, limits, deadline);
      if (res.redirect) {
        url = new URL(res.redirect, u).toString(); // relative redirects resolve against the current address
        continue;
      }
      return { bytes: res.bytes!, contentType: res.contentType!, finalUrl: u.toString() };
    }
    return reject("The address redirected too many times.");
  }

  private async once(u: URL, addrs: Resolved[], limits: FetchLimits, deadline: number): Promise<{ redirect?: string; bytes?: Buffer; contentType?: string }> {
    let lastError: unknown;
    for (const a of addrs) {
      try {
        return await this.connect(u, a, limits, deadline);
      } catch (err) {
        if (err instanceof AdError) throw err; // a policy or protocol answer: do not try another address
        lastError = err; // a connection failure: the next validated address may work
      }
    }
    void lastError;
    return reject("Could not connect to that address.");
  }

  private connect(u: URL, a: Resolved, limits: FetchLimits, deadline: number): Promise<{ redirect?: string; bytes?: Buffer; contentType?: string }> {
    return new Promise((resolve, rejectP) => {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const remaining = deadline - Date.now();
      if (remaining <= 0) return rejectP(new AdError("invalid_input", "The download took too long."));
      let done = false;
      const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
      const fail = (msg: string) => { req.destroy(); finish(() => rejectP(new AdError("invalid_input", msg))); };
      const timer = setTimeout(() => fail("The download took too long."), remaining);

      const req = this.request(
        {
          protocol: "https:",
          hostname: host,
          port: u.port ? Number(u.port) : 443,
          path: `${u.pathname}${u.search}`,
          method: "GET",
          // Connect to the address we validated, whatever DNS would say now.
          lookup: ((_h: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) =>
            options?.all ? cb(null, [{ address: a.address, family: a.family }]) : cb(null, a.address, a.family)) as never,
          servername: net.isIP(host) ? undefined : host,
          headers: { host: u.host, accept: limits.accept.join(", "), "accept-encoding": "identity", "user-agent": "hookmint-fetch/1" },
          agent: false,
          ca: this.ca,
          rejectUnauthorized: true,
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const loc = res.headers.location;
            res.resume();
            if (!loc) return fail("The address redirected without saying where.");
            return finish(() => resolve({ redirect: loc }));
          }
          if (status !== 200) { res.resume(); return fail(`The server answered with status ${status}.`); }
          const enc = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
          if (enc !== "identity") { res.resume(); return fail("Compressed downloads are not accepted."); }
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (!limits.accept.includes(type)) { res.resume(); return fail(`That file type (${type || "unknown"}) is not accepted here.`); }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > limits.maxBytes) { res.resume(); return fail("That file is too large."); }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > limits.maxBytes) return fail("That file is too large.");
            chunks.push(c);
          });
          res.on("end", () => finish(() => resolve({ bytes: Buffer.concat(chunks), contentType: type })));
          res.on("error", () => fail("The download was interrupted."));
          res.on("aborted", () => fail("The download was interrupted."));
        },
      );
      req.on("error", (err: Error) => finish(() => rejectP(err)));
      req.on("timeout", () => fail("The server did not respond in time."));
      req.setTimeout(Math.min(remaining, 10_000));
      req.end();
    });
  }
}
