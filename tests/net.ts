import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { promises as fsp, existsSync, readdirSync, statSync } from "node:fs";
import sharp from "sharp";
import { RenderInternals } from "@remotion/renderer";
import { AdError } from "../src/core/errors.js";
import { fullAccess } from "../src/core/context.js";
import { AdService } from "../src/core/service.js";
import { createStubProviders } from "../src/providers/stub.js";
import type { Renderer, RenderArgs } from "../src/providers/types.js";
import { connect, key, newReadyAd, sleep, waitForStatus } from "./helpers.js";
import { MediaIngestor } from "../src/net/ingest.js";
import { sanitizeImage } from "../src/net/images.js";
import { isBlockedHostname, isPublicAddress, parseV6 } from "../src/net/address.js";
import { SafeFetcher } from "../src/net/safe-fetch.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof AdError && e.code === "invalid_input" && re.test(e.message));

// ============ addresses ============

await test("addresses: public internet addresses are allowed, everything private or reserved is refused", async () => {
  for (const ok of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81a::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
    assert.equal(isPublicAddress(ok), true, ok);
  }
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254", "100.64.0.1", "100.127.255.255",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255",
    "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::2", "fe80::1", "fe80::abcd:1", "fc00::1", "fd00::1", "fdff:ffff::1", "fec0::1", "ff02::1", "ff00::",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a9fe:a9fe::1", "2002:c0a8:1::1",
    "2001:db8::1", "2001::1", "2001:10::1", "100::1", "not-an-ip", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "fe80::1%eth0", "[::1]",
  ];
  for (const b of blocked) assert.equal(isPublicAddress(b), false, b);
});

await test("addresses: IPv6 parsing handles compression and embedded IPv4, and refuses malformed input", async () => {
  assert.deepEqual(parseV6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseV6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseV6("2001:db8::ff00:42:8329"), [0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329]);
  assert.deepEqual(parseV6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  assert.deepEqual(parseV6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const bad of ["1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "g::1", "::ffff:1.2.3.999", "1:2:3:4:5:6:7::8", "fe80::1%1"]) assert.equal(parseV6(bad), null, bad);
});

await test("hostnames: names that can never be public are refused before any lookup", async () => {
  for (const h of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "printer.local", "metadata.google.internal", "db.internal", "router.lan", "nas.home.arpa", "intranet", "server", "example.invalid", "app.test", "site.example", "x.onion", ""]) assert.equal(isBlockedHostname(h), true, h);
  for (const h of ["example.com", "cdn.example.com", "images.pexels.com", "a.b.c.co.uk"]) assert.equal(isBlockedHostname(h), false, h);
});

// ============ URL policy: no network is ever touched ============

const noNetwork = () => new SafeFetcher({
  resolve: async () => { throw new Error("must not resolve"); },
  request: (() => { throw new Error("must not connect"); }) as never,
});
const LIM = { maxBytes: 1000, accept: ["image/png"] };

await test("URL policy: only plain public https is accepted, and nothing refused ever causes a lookup or a connection", async () => {
  const f = noNetwork();
  const refused = [
    "http://example.com/a.png", "ftp://example.com/a", "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "gopher://example.com/", "ws://example.com/",
    "https://user:pass@example.com/a.png", "https://user@example.com/a.png", "https://example.com:8443/a.png", "https://example.com:22/", "https://example.com:80/",
    "https://localhost/a.png", "https://LOCALHOST:443/", "https://foo.localhost/", "https://localhost./", "https://printer.local/", "https://metadata.google.internal/", "https://intranet/", "https://example.invalid/a.png",
    "https://127.0.0.1/", "https://2130706433/", "https://0x7f.0.0.1/", "https://0177.0.0.1/", "https://127.1/", "https://0/", "https://10.0.0.5/", "https://192.168.1.1/", "https://172.16.0.1/",
    "https://169.254.169.254/latest/meta-data/", "https://100.64.0.1/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://[::ffff:127.0.0.1]/", "https://[fd00::1]/", "https://[fe80::1]/", "https://[::]/",
    "not a url", "", "//example.com/a.png", "/relative/path.png", "https://",
  ];
  for (const url of refused) {
    assert.throws(() => f.checkUrl(url), (e: unknown) => e instanceof AdError && e.code === "invalid_input", url);
    await rejects(f.get(url, LIM), /./);
  }
  for (const ok of ["https://example.com/a.png", "https://cdn.example.com:443/x?y=1#z", "https://8.8.8.8/x", "https://[2606:4700:4700::1111]/x", "https://xn--e1afmkfd.xn--p1ai/a.png"]) {
    assert.doesNotThrow(() => f.checkUrl(ok), ok);
  }
  // The parser reads "https:///a.png" as the host "a.png". That is fine because the host that is checked is the host that is used.
  assert.equal(f.checkUrl("https:///a.png").hostname, "a.png");
  await rejects(f.get("https:///169.254.169.254/x", LIM), /private or internal/); // extra slashes cannot hide an address
  assert.doesNotMatch((() => { try { f.checkUrl("https://169.254.169.254/"); } catch (e) { return (e as Error).message; } return ""; })(), /169\.254/, "the refusal must not echo the address back");
});

// ============ resolution policy and pinning, with a fake transport ============

function fakeTransport(respond: (opts: any) => { status?: number; headers?: Record<string, string>; body?: Buffer }) {
  const seen: any[] = [];
  const request = ((opts: any, cb: (res: any) => void) => {
    seen.push(opts);
    const req: any = new EventEmitter();
    req.setTimeout = () => req; req.destroy = () => req; req.write = () => true;
    req.end = () => {
      const r = respond(opts);
      const res: any = Readable.from(r.body ? [r.body] : []);
      res.statusCode = r.status ?? 200; res.headers = r.headers ?? {};
      queueMicrotask(() => cb(res));
    };
    return req;
  }) as unknown as typeof https.request;
  return { request, seen };
}
const PNG_HEADERS = { "content-type": "image/png" };
const lookupOf = (opts: any) => new Promise<{ address: string; family: number }>((res) => opts.lookup("whatever", { all: false }, (_e: unknown, address: string, family: number) => res({ address, family })));

await test("pinning: the connection goes to the address that was validated, with the original name for TLS, and nothing identifying is sent", async () => {
  let lookups = 0;
  const t = fakeTransport(() => ({ headers: PNG_HEADERS, body: Buffer.from("hello") }));
  const f = new SafeFetcher({ resolve: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; }, request: t.request });
  const out = await f.get("https://images.example.com/logo.png?v=2", LIM);
  assert.equal(out.bytes.toString(), "hello");
  assert.equal(out.contentType, "image/png");
  assert.equal(out.finalUrl, "https://images.example.com/logo.png?v=2");
  assert.equal(lookups, 1, "resolved once");
  const o = t.seen[0];
  assert.deepEqual(await lookupOf(o), { address: "93.184.216.34", family: 4 }, "the socket lookup returns the validated address");
  assert.deepEqual(await lookupOf(o), { address: "93.184.216.34", family: 4 }, "and keeps returning it");
  assert.equal(lookups, 1, "DNS is never asked again");
  assert.equal(o.servername, "images.example.com");
  assert.equal(o.hostname, "images.example.com");
  assert.equal(o.path, "/logo.png?v=2");
  assert.equal(o.headers.host, "images.example.com");
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.agent, false);
  assert.equal(o.headers["accept-encoding"], "identity");
  const names = Object.keys(o.headers).map((h) => h.toLowerCase());
  for (const banned of ["cookie", "authorization", "referer", "proxy-authorization", "origin"]) assert.ok(!names.includes(banned), banned);
  // The "all" form of lookup (used by newer Node versions) is pinned too.
  await new Promise<void>((res) => o.lookup("x", { all: true }, (_e: unknown, list: unknown) => { assert.deepEqual(list, [{ address: "93.184.216.34", family: 4 }]); res(); }));
});

await test("resolution: one private answer among public ones refuses the request, and so do empty and failed lookups", async () => {
  const never = fakeTransport(() => { throw new Error("must not connect"); });
  const mixed = new SafeFetcher({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], request: never.request });
  await rejects(mixed.get("https://sneaky.example.com/a.png", LIM), /private or internal/);
  for (const bad of ["127.0.0.1", "169.254.169.254", "::1", "fd00::5", "::ffff:10.0.0.1"]) {
    const f = new SafeFetcher({ resolve: async () => [{ address: bad, family: bad.includes(":") ? 6 : 4 }], request: never.request });
    await rejects(f.get("https://rebind.example.com/a.png", LIM), /private or internal/);
  }
  await rejects(new SafeFetcher({ resolve: async () => [], request: never.request }).get("https://gone.example.com/a.png", LIM), /could not be looked up/);
  await rejects(new SafeFetcher({ resolve: async () => { throw new Error("ENOTFOUND secret-internal-detail"); }, request: never.request }).get("https://gone.example.com/a.png", LIM), /could not be looked up/);
  assert.equal(never.seen.length, 0);
  const err = await new SafeFetcher({ resolve: async () => { throw new Error("ENOTFOUND secret-internal-detail"); } }).get("https://gone.example.com/a.png", LIM).catch((e) => e);
  assert.doesNotMatch(err.message, /secret-internal-detail/);
});

await test("redirects: every hop is checked again, relative ones work, loops and long chains stop", async () => {
  const hosts: Record<string, string> = { "a.example.com": "8.8.8.8", "b.example.com": "1.1.1.1", "evil.example.com": "10.0.0.9" };
  const resolved: string[] = [];
  const resolve = async (h: string) => { resolved.push(h); return [{ address: hosts[h], family: 4 }]; };
  const mk = (respond: (o: any) => any) => { const t = fakeTransport(respond); return { f: new SafeFetcher({ resolve, request: t.request }), t }; };

  let { f, t } = mk((o) => (o.hostname === "a.example.com" ? { status: 302, headers: { location: "https://b.example.com/final.png" } } : { headers: PNG_HEADERS, body: Buffer.from("ok") }));
  let out = await f.get("https://a.example.com/start", LIM);
  assert.equal(out.finalUrl, "https://b.example.com/final.png");
  assert.deepEqual(resolved.splice(0), ["a.example.com", "b.example.com"], "the new host was resolved and validated on its own");
  assert.equal((await lookupOf(t.seen[1])).address, "1.1.1.1", "and pinned to its own validated address");

  ({ f } = mk((o) => (o.path === "/start" ? { status: 301, headers: { location: "/other/next.png" } } : { headers: PNG_HEADERS, body: Buffer.from("rel") })));
  out = await f.get("https://a.example.com/start", LIM);
  assert.equal(out.finalUrl, "https://a.example.com/other/next.png");

  for (const [name, location, re] of [
    ["to a private host name", "https://evil.example.com/x", /private or internal/],
    ["to a private literal", "https://127.0.0.1/x", /private or internal/],
    ["to the metadata address", "https://169.254.169.254/latest/meta-data/", /private or internal/],
    ["downgrade to http", "http://b.example.com/x", /Only https/],
    ["to a file", "file:///etc/passwd", /Only https/],
    ["to another port", "https://b.example.com:8443/x", /standard https port/],
    ["with credentials", "https://u:p@b.example.com/x", /username or password/],
  ] as const) {
    ({ f } = mk(() => ({ status: 302, headers: { location } })));
    await rejects(f.get("https://a.example.com/start", LIM), re);
    assert.ok(true, name);
  }
  ({ f } = mk(() => ({ status: 302, headers: { location: "/loop" } })));
  await rejects(f.get("https://a.example.com/loop", LIM), /redirected too many times/);
  ({ f } = mk(() => ({ status: 302, headers: {} })));
  await rejects(f.get("https://a.example.com/x", LIM), /without saying where/);
  let hops = 0;
  ({ f } = mk(() => ({ status: 302, headers: { location: `/hop${++hops}` } })));
  await rejects(f.get("https://a.example.com/x", { ...LIM, maxRedirects: 2 }), /too many times/);
  assert.equal(hops, 3, "the original request plus two redirects, then stop");
});

await test("responses: only a 200 of an allowed type, uncompressed and within the size cap is accepted", async () => {
  const r = (resp: any) => new SafeFetcher({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: fakeTransport(() => resp).request });
  const big = Buffer.alloc(1001, 1);
  await rejects(r({ status: 404 }).get("https://x.example.com/a", LIM), /status 404/);
  await rejects(r({ status: 500 }).get("https://x.example.com/a", LIM), /status 500/);
  await rejects(r({ status: 204 }).get("https://x.example.com/a", LIM), /status 204/);
  await rejects(r({ headers: { "content-type": "text/html" }, body: Buffer.from("x") }).get("https://x.example.com/a", LIM), /not accepted/);
  await rejects(r({ headers: { "content-type": "image/svg+xml" }, body: Buffer.from("x") }).get("https://x.example.com/a", LIM), /not accepted/);
  await rejects(r({ body: Buffer.from("x") }).get("https://x.example.com/a", LIM), /unknown\) is not accepted/);
  await rejects(r({ headers: { ...PNG_HEADERS, "content-encoding": "gzip" }, body: Buffer.from("x") }).get("https://x.example.com/a", LIM), /Compressed/);
  await rejects(r({ headers: { ...PNG_HEADERS, "content-length": "5000" }, body: Buffer.from("x") }).get("https://x.example.com/a", LIM), /too large/);
  await rejects(r({ headers: PNG_HEADERS, body: big }).get("https://x.example.com/a", LIM), /too large/);
  const exact = await r({ headers: PNG_HEADERS, body: Buffer.alloc(1000, 2) }).get("https://x.example.com/a", LIM);
  assert.equal(exact.bytes.length, 1000);
  const withParams = await r({ headers: { "content-type": "IMAGE/PNG; charset=binary" }, body: Buffer.from("x") }).get("https://x.example.com/a", LIM);
  assert.equal(withParams.contentType, "image/png");
});

// ============ real TLS against a local server ============

const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-tls-"));
const certArgs = (name: string, san: string) => ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, `${name}.key`), "-out", path.join(dir, `${name}.crt`), "-days", "1", "-subj", "/CN=logo.test", "-addext", `subjectAltName=${san}`];
execFileSync("openssl", certArgs("good", "DNS:logo.test,IP:127.0.0.1"), { stdio: "ignore" });
execFileSync("openssl", certArgs("wrongname", "DNS:something-else.test"), { stdio: "ignore" });
const good = { key: readFileSync(path.join(dir, "good.key")), cert: readFileSync(path.join(dir, "good.crt")) };
const wrong = { key: readFileSync(path.join(dir, "wrongname.key")), cert: readFileSync(path.join(dir, "wrongname.crt")) };

const snis: string[] = [];
const PNGBYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const server = https.createServer({ ...good, SNICallback: (name: string, cb: (e: Error | null, ctx?: never) => void) => { snis.push(name); cb(null, undefined as never); } } as never, (req, res) => {
  const url = new URL(req.url!, "https://x");
  const p = url.pathname;
  if (p === "/ok.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNGBYTES);
  if (p === "/echo") return void res.writeHead(200, { "content-type": "image/png" }).end(JSON.stringify({ host: req.headers.host, headers: req.headers }));
  if (p === "/redir") return void res.writeHead(302, { location: "/ok.png" }).end();
  if (p === "/redir-out") return void res.writeHead(302, { location: url.searchParams.get("to")! }).end();
  if (p === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
  if (p === "/declared-big") return void res.writeHead(200, { "content-type": "image/png", "content-length": "99999999" }).write("x");
  if (p === "/endless") { res.writeHead(200, { "content-type": "image/png" }); const t = setInterval(() => res.write(Buffer.alloc(4096, 1)), 1); res.on("close", () => clearInterval(t)); return; }
  if (p === "/gzip") return void res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip" }).end("x");
  if (p === "/html") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>");
  if (p === "/hang") return;
  if (p === "/drip") { res.writeHead(200, { "content-type": "image/png" }); const t = setInterval(() => res.write("x"), 100); res.on("close", () => clearInterval(t)); return; }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const local = (extra: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) => new SafeFetcher({ allowPrivateNetworks: true, ca: good.cert, ...extra });
const base = `https://127.0.0.1:${port}`;

try {
  await test("TLS: real bytes come back over a real verified connection, with a pinned address and the right name sent", async () => {
    const f = local({ resolve: async (h) => { assert.equal(h, "logo.test"); return [{ address: "127.0.0.1", family: 4 }]; } });
    const out = await f.get(`https://logo.test:${port}/ok.png`, { maxBytes: 100, accept: ["image/png"] });
    assert.deepEqual(out.bytes, PNGBYTES);
    assert.ok(snis.includes("logo.test"), `the server saw the name in the handshake: ${snis}`);
    const echo = JSON.parse((await f.get(`https://logo.test:${port}/echo`, { maxBytes: 100000, accept: ["image/png"] })).bytes.toString());
    assert.equal(echo.host, `logo.test:${port}`);
    assert.equal(echo.headers["accept-encoding"], "identity");
    for (const h of ["cookie", "authorization", "referer"]) assert.equal(echo.headers[h], undefined, h);
  });

  await test("TLS: certificates are verified, so an untrusted or wrong-name server is refused", async () => {
    const untrusted = new SafeFetcher({ allowPrivateNetworks: true }); // no extra CA
    await assert.rejects(untrusted.get(`${base}/ok.png`, { maxBytes: 100, accept: ["image/png"] }));
    const wrongServer = https.createServer(wrong, (_q, s) => s.writeHead(200, { "content-type": "image/png" }).end("x"));
    await new Promise<void>((r) => wrongServer.listen(0, "127.0.0.1", r));
    const wp = (wrongServer.address() as AddressInfo).port;
    try {
      await assert.rejects(new SafeFetcher({ allowPrivateNetworks: true, ca: wrong.cert }).get(`https://127.0.0.1:${wp}/x`, { maxBytes: 100, accept: ["image/png"] }), "a certificate for a different name must not be accepted");
    } finally { wrongServer.close(); }
  });

  await test("redirects over TLS: relative redirects work, loops stop, and a redirect to the metadata address is refused", async () => {
    const lim = { maxBytes: 100, accept: ["image/png"] };
    const out = await local().get(`${base}/redir`, lim);
    assert.deepEqual(out.bytes, PNGBYTES);
    assert.equal(out.finalUrl, `${base}/ok.png`);
    await rejects(local().get(`${base}/loop`, lim), /too many times/);
    // Private networks are allowed for THIS fetcher (it talks to localhost), but a normal one refuses the same redirect.
    const strict = new SafeFetcher({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], request: ((o: any, cb: any) => {
      const req: any = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => req; req.end = () => { const res: any = Readable.from([]); res.statusCode = 302; res.headers = { location: "https://169.254.169.254/latest/meta-data/" }; queueMicrotask(() => cb(res)); }; return req;
    }) as never });
    await rejects(strict.get("https://good.example.com/x", lim), /private or internal/);
  });

  await test("limits over TLS: an oversized or endless body is cut off early, wrong types and compression are refused", async () => {
    const lim = { maxBytes: 5000, accept: ["image/png"] };
    const t0 = Date.now();
    await rejects(local().get(`${base}/declared-big`, lim), /too large/);
    await rejects(local().get(`${base}/endless`, lim), /too large/);
    assert.ok(Date.now() - t0 < 3000, "refused promptly instead of downloading everything");
    await rejects(local().get(`${base}/gzip`, lim), /Compressed/);
    await rejects(local().get(`${base}/html`, lim), /not accepted/);
    await rejects(local().get(`${base}/missing`, lim), /status 404/);
  });

  await test("time limits: a server that never answers, and one that drips data forever, both stop at the deadline", async () => {
    const lim = { maxBytes: 1_000_000, accept: ["image/png"], timeoutMs: 400 };
    let t0 = Date.now();
    await rejects(local().get(`${base}/hang`, lim), /too long|did not respond/);
    assert.ok(Date.now() - t0 < 2500, `hang stopped in ${Date.now() - t0}ms`);
    t0 = Date.now();
    await rejects(local().get(`${base}/drip`, lim), /too long|did not respond/);
    assert.ok(Date.now() - t0 < 2500, `drip stopped in ${Date.now() - t0}ms`);
  });
} finally {
  server.closeAllConnections();
  server.close();
}

// ============ images ============

const solid = (w: number, h: number, alpha = 1) => ({ create: { width: w, height: h, channels: 4 as const, background: { r: 200, g: 30, b: 30, alpha } } });
const bad = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof AdError && e.code === "invalid_input" && re.test(e.message));

await test("images: a logo is re-encoded as a PNG, scaled to fit, transparency kept, and metadata gone", async () => {
  const input = await sharp(solid(1600, 800, 0.5)).withMetadata({ exif: { IFD0: { Copyright: "secret-owner" } } }).png().toBuffer();
  assert.ok((await sharp(input).metadata()).exif, "the input really carries EXIF");
  const out = await sanitizeImage(input, "logo");
  assert.equal(out.format, "png");
  assert.equal(Math.max(out.width, out.height), 1024);
  assert.equal(out.width, 1024); assert.equal(out.height, 512);
  const m = await sharp(out.bytes).metadata();
  assert.equal(m.format, "png"); assert.equal(m.hasAlpha, true);
  assert.equal(m.exif, undefined, "metadata is stripped");
  assert.ok(!out.bytes.includes(Buffer.from("secret-owner")));
  const small = await sanitizeImage(await sharp(solid(100, 60)).png().toBuffer(), "logo");
  assert.deepEqual([small.width, small.height], [100, 60], "small images are not enlarged");
});

await test("images: photos become JPEG (PNG only when they need transparency), orientation is applied, size is capped", async () => {
  const jpeg = await sharp(solid(400, 200)).flatten({ background: "#fff" }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await sharp(jpeg).metadata()).orientation, 6);
  const out = await sanitizeImage(jpeg, "photo");
  assert.equal(out.format, "jpeg");
  assert.deepEqual([out.width, out.height], [200, 400], "rotated upright");
  assert.equal((await sharp(out.bytes).metadata()).orientation, undefined);
  const huge = await sanitizeImage(await sharp(solid(4000, 3000)).flatten({ background: "#fff" }).jpeg().toBuffer(), "photo");
  assert.equal(Math.max(huge.width, huge.height), 2160);
  assert.equal((await sanitizeImage(await sharp(solid(300, 300, 0.4)).png().toBuffer(), "photo")).format, "png");
  const fromPng = await sanitizeImage(await sharp(solid(300, 300)).flatten({ background: "#fff" }).png().toBuffer(), "photo");
  assert.equal(fromPng.format, "jpeg");
});

await test("images: SVG, GIF, TIFF, HTML, garbage, truncated, tiny, empty and pixel-bomb inputs are all refused", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><image href="http://169.254.169.254/x"/></svg>');
  await bad(sanitizeImage(svg, "logo"), /svg\) is not accepted/);
  await bad(sanitizeImage(await sharp(solid(64, 64)).gif().toBuffer(), "logo"), /gif\) is not accepted/);
  await bad(sanitizeImage(await sharp(solid(64, 64)).tiff().toBuffer(), "logo"), /tiff\) is not accepted/);
  for (const junk of [Buffer.from("<html><body>hi</body></html>"), Buffer.from("not an image at all"), Buffer.alloc(0), Buffer.alloc(2000, 7), Buffer.from("%PDF-1.4 fake")]) {
    await bad(sanitizeImage(junk, "logo"), /not a readable|not accepted/);
  }
  const png = await sharp(solid(200, 200)).png().toBuffer();
  await bad(sanitizeImage(png.subarray(0, Math.floor(png.length / 2)), "logo"), /not a readable/);
  await bad(sanitizeImage(await sharp(solid(8, 8)).png().toBuffer(), "logo"), /too small/);
  await bad(sanitizeImage(await sharp(solid(3000, 3000)).png().toBuffer(), "logo", { maxInputPixels: 1_000_000, maxSide: 1024, maxOutputBytes: 1_000_000 }), /not a readable/);
  await bad(sanitizeImage(png, "logo", { maxInputPixels: 1e8, maxSide: 1024, maxOutputBytes: 10 }), /too large once processed/);
  const err = await sanitizeImage(Buffer.from("not an image at all"), "logo").catch((e) => e);
  assert.doesNotMatch(err.message, /vips|sharp|libpng|Input buffer/i, "decoder internals are not shown to users");
});

await test("images: bytes appended after a real image, or a script hidden in one, do not survive re-encoding", async () => {
  const png = await sharp(solid(120, 120)).png().toBuffer();
  const polyglot = Buffer.concat([png, Buffer.from("<script>alert('pwned')</script><?php system($_GET['c']); ?>")]);
  const out = await sanitizeImage(polyglot, "logo");
  assert.ok(!out.bytes.includes(Buffer.from("<script>")) && !out.bytes.includes(Buffer.from("<?php")));
  const withText = await sharp(solid(120, 120)).withMetadata({ exif: { IFD0: { ImageDescription: "<script>x</script>" } } }).jpeg().toBuffer();
  assert.ok(!(await sanitizeImage(withText, "photo")).bytes.includes(Buffer.from("<script>")));
});

// ============ ingestion ============

const root = mkdtempSync(path.join(os.tmpdir(), "hookmint-ingest-"));
const fakeFetcher = (files: Record<string, { bytes: Buffer; type: string }>) => {
  const calls: { url: string; limits: any }[] = [];
  return {
    calls,
    checkUrl: () => new URL("https://example.com"),
    get: async (url: string, limits: any) => {
      calls.push({ url, limits });
      const f = files[url];
      if (!f) throw new AdError("invalid_input", "The server answered with status 404.");
      if (!limits.accept.includes(f.type)) throw new AdError("invalid_input", `That file type (${f.type}) is not accepted here.`);
      return { bytes: f.bytes, contentType: f.type, finalUrl: url };
    },
  };
};
const leftovers = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /incoming|\.probe/.test(f)) : []);

await test("ingest: a logo lands at a server-chosen path, as a clean PNG, and unsafe ids can never choose another path", async () => {
  const bytes = await sharp(solid(1500, 900)).png().toBuffer();
  const f = fakeFetcher({ "https://cdn.example.com/logo.png": { bytes, type: "image/png" }, "https://cdn.example.com/bad.png": { bytes: Buffer.from("<html>"), type: "image/png" }, "https://cdn.example.com/doc.svg": { bytes: Buffer.from("<svg/>"), type: "image/svg+xml" } });
  const ing = new MediaIngestor(f, root);
  const r = await ing.logo("acct_a", "bk_12345678", "https://cdn.example.com/logo.png");
  assert.equal(r.path, path.join(root, "logos", "acct_a", "bk_12345678.png"));
  assert.equal((await sharp(r.path).metadata()).width, 1024);
  assert.equal(statSync(r.path).mode & 0o777, 0o600, "stored private");
  assert.deepEqual(f.calls[0].limits.accept, ["image/png", "image/jpeg", "image/webp"], "SVG is never even requested");
  assert.equal(f.calls[0].limits.maxBytes, 5 * 1024 * 1024);
  await bad(ing.logo("acct_a", "bk_bad00000", "https://cdn.example.com/bad.png"), /not a readable/);
  assert.equal(existsSync(path.join(root, "logos", "acct_a", "bk_bad00000.png")), false, "nothing stored for a refused image");
  await bad(ing.logo("acct_a", "bk_svg00000", "https://cdn.example.com/doc.svg"), /not accepted/);
  await bad(ing.logo("acct_a", "bk_x", "https://cdn.example.com/missing.png"), /status 404/);
  for (const [acct, kit] of [["../evil", "bk_1"], ["acct_a", "../../etc/passwd"], ["acct_a", "a/b"], ["acct a", "bk_1"], ["", "bk_1"], ["acct_a", "x".repeat(65)], ["acct_a", "bk_1.png"]]) {
    await bad(ing.logo(acct, kit, "https://cdn.example.com/logo.png"), /Unsafe/);
  }
  assert.deepEqual(leftovers(root), [], "no temporary files left behind");
  const again = await ing.logo("acct_a", "bk_12345678", "https://cdn.example.com/logo.png");
  assert.equal(again.path, r.path, "re-fetching replaces the same file");
});

await test("ingest: scene images are stored under a content hash, so identical images share one file and the URL never names a path", async () => {
  const jpg = await sharp(solid(640, 360)).flatten({ background: "#fff" }).jpeg().toBuffer();
  const f = fakeFetcher({ "https://a.example.com/x/../../../etc/passwd.jpg": { bytes: jpg, type: "image/jpeg" }, "https://b.example.com/same.jpg": { bytes: jpg, type: "image/jpeg" } });
  const ing = new MediaIngestor(f, root);
  const p1 = await ing.image("acct_a", "https://a.example.com/x/../../../etc/passwd.jpg");
  const p2 = await ing.image("acct_a", "https://b.example.com/same.jpg");
  assert.equal(p1, p2);
  assert.match(p1, new RegExp(`^${root}/fetched/acct_a/[0-9a-f]{24}\\.jpg$`));
  const other = await ing.image("acct_b", "https://b.example.com/same.jpg");
  assert.notEqual(path.dirname(other), path.dirname(p1), "each account has its own folder");
});

const ffmpeg = RenderInternals.getExecutablePath({ type: "ffmpeg", indent: false, logLevel: "error", binariesDirectory: null });
async function makeMp4(file: string, seconds: number, size = 64): Promise<void> {
  // Built from PNG frames, since Remotion's trimmed ffmpeg has no raw-video input.
  const frames = mkdtempSync(path.join(os.tmpdir(), "hookmint-frames-"));
  const png = await sharp({ create: { width: size, height: size, channels: 3, background: { r: 30, g: 140, b: 70 } } }).png().toBuffer();
  for (let i = 0; i < seconds * 10; i++) await fsp.writeFile(path.join(frames, `f${String(i).padStart(3, "0")}.png`), png);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-y", "-framerate", "10", "-i", path.join(frames, "f%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr!.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err}`))));
  });
}
function wav(seconds: number, sr = 8000): Buffer {
  const samples = Math.round(sr * seconds); const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 9000), 44 + i * 2);
  return b;
}

await test("ingest: audio must really be the audio it claims to be; wrong containers, text, playlists and over-long files are refused", async () => {
  const audioRoot = mkdtempSync(path.join(os.tmpdir(), "hookmint-audio-"));
  const good = wav(1);
  const hls = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5,\nhttp://169.254.169.254/latest/meta-data/\n#EXT-X-ENDLIST\n");
  const f = fakeFetcher({
    "https://a.example.com/v.wav": { bytes: good, type: "audio/wav" },
    "https://a.example.com/as-mp3.wav": { bytes: good, type: "audio/mpeg" },
    "https://a.example.com/text.mp3": { bytes: Buffer.from("this is not audio"), type: "audio/mpeg" },
    "https://a.example.com/playlist.m4a": { bytes: hls, type: "audio/mp4" },
    "https://a.example.com/long.wav": { bytes: wav(3), type: "audio/wav" },
    "https://a.example.com/empty.wav": { bytes: Buffer.alloc(0), type: "audio/wav" },
  });
  const ing = new MediaIngestor(f, audioRoot, { ...(await import("../src/net/ingest.js")).DEFAULT_INGEST, maxAudioSeconds: 2 });
  const ok = await ing.audio("acct_a", "https://a.example.com/v.wav");
  assert.match(ok, /\/fetched\/acct_a\/[0-9a-f]{24}\.wav$/);
  assert.deepEqual(readFileSync(ok), good);
  await bad(ing.audio("acct_a", "https://a.example.com/as-mp3.wav"), /not a valid media file/);
  await bad(ing.audio("acct_a", "https://a.example.com/text.mp3"), /not a valid media file/);
  await bad(ing.audio("acct_a", "https://a.example.com/playlist.m4a"), /not a valid media file/);
  await bad(ing.audio("acct_a", "https://a.example.com/long.wav"), /between a moment and 2 seconds/);
  await bad(ing.audio("acct_a", "https://a.example.com/empty.wav"), /not a valid media file/);
  assert.deepEqual(leftovers(audioRoot), [], "refused files leave nothing behind");
});

await test("ingest: video must be a real, bounded H.264 clip; mislabelled, over-long or over-large clips are refused", async () => {
  const vroot = mkdtempSync(path.join(os.tmpdir(), "hookmint-video-"));
  const small = path.join(vroot, "src-small.mp4"); const longer = path.join(vroot, "src-long.mp4"); const wide = path.join(vroot, "src-wide.mp4");
  await makeMp4(small, 1); await makeMp4(longer, 3); await makeMp4(wide, 1, 256);
  const f = fakeFetcher({
    "https://a.example.com/c.mp4": { bytes: readFileSync(small), type: "video/mp4" },
    "https://a.example.com/as-webm.mp4": { bytes: readFileSync(small), type: "video/webm" },
    "https://a.example.com/long.mp4": { bytes: readFileSync(longer), type: "video/mp4" },
    "https://a.example.com/wide.mp4": { bytes: readFileSync(wide), type: "video/mp4" },
    "https://a.example.com/text.mp4": { bytes: Buffer.from("<html>not a video</html>"), type: "video/mp4" },
    "https://a.example.com/audio.mp4": { bytes: wav(1), type: "video/mp4" },
  });
  const lim = { ...(await import("../src/net/ingest.js")).DEFAULT_INGEST, maxVideoSeconds: 2, maxVideoSide: 128 };
  const ing = new MediaIngestor(f, vroot, lim);
  const ok = await ing.video("acct_a", "https://a.example.com/c.mp4");
  assert.match(ok, /\/fetched\/acct_a\/[0-9a-f]{24}\.mp4$/);
  assert.equal(f.calls[0].limits.maxBytes, 200 * 1024 * 1024);
  assert.deepEqual(f.calls[0].limits.accept, ["video/mp4", "video/webm"]);
  await bad(ing.video("acct_a", "https://a.example.com/as-webm.mp4"), /not a valid media file/); // an MP4 declared as WebM
  await bad(ing.video("acct_a", "https://a.example.com/long.mp4"), /between a moment and 2 seconds/);
  await bad(ing.video("acct_a", "https://a.example.com/wide.mp4"), /too large in pixels/);
  await bad(ing.video("acct_a", "https://a.example.com/text.mp4"), /not a valid media file/);
  await bad(ing.video("acct_a", "https://a.example.com/audio.mp4"), /not a valid media file/);
  assert.deepEqual(leftovers(vroot), [], "refused files leave nothing behind");
});

// ============ service integration ============

const settle = async (read: () => Promise<{ json: any }>, until: (j: any) => boolean, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const j = (await read()).json;
    if (until(j)) return j;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last: ${JSON.stringify(j).slice(0, 300)}`);
    await sleep(10);
  }
};
const policyOnly = new SafeFetcher(); // for the no-network address checks
const withPolicy = (f: ReturnType<typeof fakeFetcher>) => ({ get: f.get, checkUrl: (u: string) => policyOnly.checkUrl(u) });

await test("logos: checked at once, downloaded in the background, cleaned, never shown as a path, and fetched once", async () => {
  const assetDir = mkdtempSync(path.join(os.tmpdir(), "hookmint-logo-"));
  const png = await sharp(solid(1800, 600, 0.8)).png().toBuffer();
  const f = fakeFetcher({ "https://cdn.example.com/logo.png": { bytes: png, type: "image/png" }, "https://cdn.example.com/broken.png": { bytes: Buffer.from("<html>nope</html>"), type: "image/png" } });
  const service = new AdService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5, ingestor: new MediaIngestor(withPolicy(f), assetDir) });
  const ctx = fullAccess("acct_a");
  const { call } = await connect(service, ctx);

  const made = await call("create_brand_kit", { name: "Sparkle", colors: ["#0a84ff"], logo_url: "https://cdn.example.com/logo.png" });
  assert.equal(made.isError, false, made.text);
  assert.equal(made.json.logo_status, "pending");
  const id = made.json.brand_kit_id as string;
  const ready = await settle(() => call("get_brand_kit", { brand_kit_id: id }), (j) => j.logo_status === "ready");
  assert.equal(ready.name, "Sparkle");
  assert.equal(JSON.stringify(ready).includes(assetDir), false, "the server path is never shown");
  assert.equal("account_id" in ready, false);
  assert.equal(ready.logo_url, "https://cdn.example.com/logo.png");
  const file = path.join(assetDir, "logos", "acct_a", `${id}.png`);
  const meta = await sharp(file).metadata();
  assert.deepEqual([meta.format, meta.width, meta.hasAlpha], ["png", 1024, true]);
  for (const row of service.store.outbox) service.redeliver(row.id);
  await sleep(50);
  assert.equal(f.calls.length, 1, "redelivery does not download again");

  const broken = await call("create_brand_kit", { name: "Broken", logo_url: "https://cdn.example.com/broken.png" });
  const failed = await settle(() => call("get_brand_kit", { brand_kit_id: broken.json.brand_kit_id }), (j) => j.logo_status === "failed");
  assert.match(failed.logo_error, /not a readable/);
  const gone = await call("create_brand_kit", { name: "Missing", logo_url: "https://cdn.example.com/404.png" });
  assert.match((await settle(() => call("get_brand_kit", { brand_kit_id: gone.json.brand_kit_id }), (j) => j.logo_status === "failed")).logo_error, /status 404/);
  assert.equal((await call("create_brand_kit", { name: "NoLogo" })).json.logo_status, "none");
  assert.equal((await call("get_brand_kit", { brand_kit_id: broken.json.brand_kit_id })).json.logo_status, "failed");
  const ad = await newReadyAd(call, { brand_kit_id: broken.json.brand_kit_id });
  assert.ok(ad, "a kit whose logo failed can still be used for ads");
});

await test("logos: a bad address is refused immediately and nothing is stored or queued", async () => {
  const f = fakeFetcher({});
  const service = new AdService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5, ingestor: new MediaIngestor(withPolicy(f), mkdtempSync(path.join(os.tmpdir(), "hookmint-logo-"))) });
  const { call } = await connect(service, fullAccess("acct_a"));
  for (const url of ["http://cdn.example.com/logo.png", "https://127.0.0.1/logo.png", "https://169.254.169.254/latest/meta-data/", "https://localhost/logo.png", "https://u:p@cdn.example.com/logo.png", "https://cdn.example.com:8443/logo.png", "https://[::1]/logo.png", "https://printer.local/logo.png"]) {
    const r = await call("create_brand_kit", { name: "X", logo_url: url });
    assert.equal(r.isError, true, url);
    assert.match(r.text, /^\[invalid_input\]/, url);
  }
  assert.equal(service.store.brandKits.size, 0);
  assert.equal(service.store.outbox.length, 0);
  assert.equal(f.calls.length, 0, "no request was ever made");
});

await test("logos: without a downloader the kit says so honestly, and brand kits stay private to their account and scope", async () => {
  const service = new AdService(createStubProviders({ delayMs: 5 }), { retryBaseMs: 5 });
  const ctx = fullAccess("acct_a");
  const { call } = await connect(service, ctx);
  const made = await call("create_brand_kit", { name: "S", logo_url: "https://cdn.example.com/logo.png" });
  assert.equal(made.json.logo_status, "unavailable");
  const kit = (await call("get_brand_kit", { brand_kit_id: made.json.brand_kit_id })).json;
  assert.match(kit.logo_error, /not set up on this server/);
  assert.match((await (await connect(service, fullAccess("acct_b"))).call("get_brand_kit", { brand_kit_id: made.json.brand_kit_id })).text, /^\[not_found\]/);
  const noRead = await connect(service, { accountId: "acct_a", scopes: new Set(["ads:read"]) });
  assert.match((await noRead.call("get_brand_kit", { brand_kit_id: made.json.brand_kit_id })).text, /^\[forbidden\]/);
  assert.match((await call("get_brand_kit", { brand_kit_id: "bk_missing" })).text, /^\[not_found\]/);
  assert.equal(service.store.outbox.length, 0, "nothing was queued");
});

await test("scene media: remote stills, clips and voiceovers become local files for the renderer; failures fall back and say why", async () => {
  const assetDir = mkdtempSync(path.join(os.tmpdir(), "hookmint-media-"));
  const frames = path.join(assetDir, "clip.mp4"); await makeMp4(frames, 1);
  const img = await sharp(solid(800, 450)).flatten({ background: "#fff" }).jpeg().toBuffer();
  const logo = await sharp(solid(600, 200)).png().toBuffer();
  const f = fakeFetcher({
    "https://stock.example.com/still.jpg": { bytes: img, type: "image/jpeg" },
    "https://stock.example.com/clip.mp4": { bytes: readFileSync(frames), type: "video/mp4" },
    "https://voice.example.com/line.wav": { bytes: wav(1), type: "audio/wav" },
    "https://cdn.example.com/logo.png": { bytes: logo, type: "image/png" },
  });
  const localFile = path.join(assetDir, "local.png"); await fsp.writeFile(localFile, await sharp(solid(64, 64)).png().toBuffer());
  const seen: RenderArgs[] = [];
  const renderer: Renderer = { render: async (a) => { seen.push(a); return { url: "https://example.invalid/r.mp4", notes: ["renderer note"] }; } };
  const stub = createStubProviders({ delayMs: 5 });
  const byScene: Record<string, { url: string; kind?: "image" | "video" }> = {
    s1: { url: "https://stock.example.com/still.jpg" },
    s2: { url: "https://stock.example.com/clip.mp4", kind: "video" },
    s3: { url: "https://stock.example.com/missing.jpg" },
    s4: { url: `file://${localFile}` },
  };
  const providers = {
    ...stub, renderer,
    visual: { generate: async (s: { id: string }) => ({ ...byScene[s.id], provider: "test" }) },
    voice: { generate: async (s: { id: string }) => ({ url: s.id === "s1" ? "https://voice.example.com/line.wav" : s.id === "s2" ? "https://voice.example.com/missing.wav" : "", provider: "test" }) },
  } as unknown as typeof stub;
  const service = new AdService(providers, { retryBaseMs: 5, ingestor: new MediaIngestor(withPolicy(f), assetDir) });
  const ctx = fullAccess("acct_a"); service.grantCredits(ctx.accountId, 500, "t");
  const { call } = await connect(service, ctx);
  const kit = (await call("create_brand_kit", { name: "S", logo_url: "https://cdn.example.com/logo.png" })).json.brand_kit_id as string;
  await settle(() => call("get_brand_kit", { brand_kit_id: kit }), (j) => j.logo_status === "ready");
  const id = await newReadyAd(call, { brand_kit_id: kit });
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  const done = await waitForStatus(call, id, "completed", 10_000);

  const a = seen[0].assets;
  assert.match(a.s1.visual_url, new RegExp(`^file://${assetDir}/fetched/acct_a/[0-9a-f]{24}\\.jpg$`), "a remote still became a local file");
  assert.match(a.s2.visual_url, new RegExp(`^file://${assetDir}/fetched/acct_a/[0-9a-f]{24}\\.mp4$`), "a remote clip became a local file");
  assert.match(a.s1.voice_url, new RegExp(`^file://${assetDir}/fetched/acct_a/[0-9a-f]{24}\\.wav$`), "a remote voiceover became a local file");
  assert.equal(a.s3.visual_url, "https://stock.example.com/missing.jpg", "a failed download keeps its original address; the renderer will not use it");
  assert.equal(a.s2.voice_url, "https://voice.example.com/missing.wav");
  assert.equal(a.s4.visual_url, `file://${localFile}`, "a local file passes straight through");
  assert.equal(seen[0].logoPath, path.join(assetDir, "logos", "acct_a", `${kit}.png`));
  const notes = done.renders[0].notes.join("\n");
  assert.match(notes, /Scene s3: the visual could not be downloaded \(The server answered with status 404\.\); the brand gradient was used instead\./);
  assert.match(notes, /Scene s2: the voiceover could not be downloaded \(The server answered with status 404\.\); that part is silent\./);
  assert.match(notes, /renderer note/);
  assert.doesNotMatch(notes, /s1|s4/, "scenes that worked get no complaint");
  assert.deepEqual(f.calls.filter((c) => c.url.includes("still.jpg") || c.url.includes("clip.mp4")).length, 2, "each remote file was fetched once");
  const asked = f.calls.find((c) => c.url.endsWith("clip.mp4"))!.limits;
  assert.deepEqual(asked.accept, ["video/mp4", "video/webm"]);
  assert.equal(JSON.stringify(done).includes(assetDir), false, "local paths are not shown to clients");
});

await test("scene media: without a downloader remote addresses are left alone, and a logo that is not ready is mentioned", async () => {
  const seen: RenderArgs[] = [];
  const renderer: Renderer = { render: async (a) => { seen.push(a); return { url: "https://example.invalid/r.mp4" }; } };
  const stub = createStubProviders({ delayMs: 5 });
  const providers = { ...stub, renderer, visual: { generate: async () => ({ url: "https://stock.example.com/a.jpg", provider: "t" }) } } as unknown as typeof stub;
  const service = new AdService(providers, { retryBaseMs: 5 });
  const ctx = fullAccess("acct_a"); service.grantCredits(ctx.accountId, 500, "t");
  const { call } = await connect(service, ctx);
  const kit = (await call("create_brand_kit", { name: "S", logo_url: "https://cdn.example.com/logo.png" })).json.brand_kit_id as string;
  const id = await newReadyAd(call, { brand_kit_id: kit });
  await call("approve_and_render", { job_id: id, max_credits: (await call("estimate_cost", { job_id: id })).json.credits, idempotency_key: key() });
  const done = await waitForStatus(call, id, "completed", 10_000);
  assert.equal(seen[0].assets.s1.visual_url, "https://stock.example.com/a.jpg");
  assert.equal(seen[0].logoPath, undefined);
  assert.match(done.renders[0].notes.join(" "), /logo is not available \(Logo downloading is not set up on this server/);
});

console.log(`net passed: ${n} checks`);
process.exit(0);
