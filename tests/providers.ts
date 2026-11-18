import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fullAccess } from "../src/core/context.js";
import { AdError } from "../src/core/errors.js";
import type { Scene } from "../src/core/schemas.js";
import { MediaIngestor } from "../src/net/ingest.js";
import { createProviders } from "../src/providers/index.js";
import { OpenAIVoiceProvider } from "../src/providers/openai-voice.js";
import { keywords, PexelsVisualProvider } from "../src/providers/pexels.js";
import { PixabayVisualProvider } from "../src/providers/pixabay.js";
import { StockChainVisualProvider } from "../src/providers/stock-chain.js";
import { createStubProviders } from "../src/providers/stub.js";
import type { RenderArgs, Renderer, VisualProvider } from "../src/providers/types.js";
import { connect, key, newReadyAd, TEST_LIMITS, waitForStatus, newService } from "./helpers.js";

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};

const scene = (over: Partial<Scene> = {}): Scene => ({ id: "s1", duration_s: 4, visual_prompt: "A happy family relaxing in a bright, clean living room", visual_source: "stock", voiceover: "Your weekend back, starting today.", claims: [], ...over });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Seen { url: string; init: RequestInit }
/** A fake fetch that records every request and answers from a queue or a function. */
const fake = (answer: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, init });
    return answer(new URL(url), init);
  }) as typeof fetch;
  return { f, seen };
};
const never: VisualProvider = { generate: async () => { throw new Error("fallback should not be used"); } };
const fallbackUsed = () => { const c = { n: 0 }; return { c, p: { generate: async (s: Scene) => { c.n++; return { url: `https://fallback.invalid/${s.id}.mp4`, provider: "fallback" }; } } as VisualProvider }; };

const mp4File = (width: number, height: number, link: string, file_type = "video/mp4") => ({ file_type, width, height, link });
const video = (id: number, duration: number, files: ReturnType<typeof mp4File>[]) => ({ id, duration, video_files: files });
const photo = (id: number, large2x: string) => ({ id, src: { large2x, large: large2x } });

// ============ Pexels ============

await test("pexels: a creative brief becomes a few plain search words", async () => {
  assert.equal(keywords("A happy family relaxing in a bright, clean living room"), "happy family relaxing bright clean living");
  assert.equal(keywords("Scene 2 for: spring | style: cinematic slow motion"), "scene spring");
  assert.equal(keywords("the and of"), "");
  assert.equal(keywords("Cats, cats, CATS and dogs"), "cats dogs");
});

await test("pexels: finds a clip, sends the key only in the Authorization header, and asks for the right shape", async () => {
  const { f, seen } = fake(() => json({ videos: [video(1, 12, [mp4File(1080, 1920, "https://videos.pexels.com/a-hd.mp4"), mp4File(540, 960, "https://videos.pexels.com/a-sd.mp4"), mp4File(2160, 3840, "https://videos.pexels.com/a-4k.mp4"), mp4File(1080, 1920, "https://videos.pexels.com/a.webm", "video/webm")])] }));
  const p = new PexelsVisualProvider({ apiKey: "PEXELS-SECRET-KEY", fetch: f, fallback: never });
  const r = await p.generate(scene());
  assert.deepEqual(r, { url: "https://videos.pexels.com/a-hd.mp4", provider: "pexels", kind: "video" }, "the largest mp4 up to 1080 on its short side");
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, "https://api.pexels.com/videos/search");
  assert.equal(u.searchParams.get("query"), "happy family relaxing bright clean living");
  assert.equal(u.searchParams.get("orientation"), "portrait");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "PEXELS-SECRET-KEY");
  assert.ok(!seen[0].url.includes("PEXELS-SECRET-KEY"), "the key is never in the URL");
  assert.equal(seen[0].init.redirect, "error", "redirects are refused so the key cannot travel");
});

await test("pexels: falls back to a photo, and tries a shorter search when the long one finds nothing", async () => {
  const { f, seen } = fake((u) => {
    if (u.pathname === "/videos/search") return json({ videos: [] });
    if (u.searchParams.get("query")!.split(" ").length > 3) return json({ photos: [] });
    return json({ photos: [photo(7, "https://images.pexels.com/photos/7/large2x.jpeg")] });
  });
  const r = await new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: never }).generate(scene());
  assert.deepEqual(r, { url: "https://images.pexels.com/photos/7/large2x.jpeg", provider: "pexels", kind: "image" });
  assert.deepEqual(seen.map((s) => new URL(s.url).searchParams.get("query")), ["happy family relaxing bright clean living", "happy family relaxing bright clean living", "happy family relaxing", "happy family relaxing"].slice(0, seen.length));
  assert.ok(seen.some((s) => new URL(s.url).searchParams.get("query") === "happy family relaxing" && s.url.includes("/v1/search")));
  const photoOnly = fake(() => json({ photos: [photo(1, "https://images.pexels.com/p.jpeg")] }));
  const r2 = await new PexelsVisualProvider({ apiKey: "k", fetch: photoOnly.f, fallback: never, media: "photo" }).generate(scene());
  assert.equal(r2.kind, "image");
  assert.ok(photoOnly.seen.every((s) => s.url.includes("/v1/search")), "photo mode never asks for clips");
});

await test("pexels: clips from unexpected hosts, or not https, are never used; nothing usable is a plain 'try simpler words' error", async () => {
  const { f } = fake(() => json({ videos: [video(1, 9, [mp4File(1080, 1920, "https://evil.example/a.mp4"), mp4File(1080, 1920, "http://videos.pexels.com/b.mp4"), mp4File(1080, 1920, "https://videos.pexels.com.evil.example/c.mp4"), mp4File(1080, 1920, "https://notpexels.com/d.mp4")])], photos: [photo(1, "file:///etc/passwd"), photo(2, "https://169.254.169.254/x.jpg")] }));
  await assert.rejects(new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: never }).generate(scene()), (e: AdError) => e.code === "not_found" && e.retry === false && /simpler words/.test(e.message));
  await assert.rejects(new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: never }).generate(scene({ visual_prompt: "the and of" })), (e: AdError) => e.code === "invalid_input");
});

await test("pexels: clips long enough for the scene come first, and each scene tends to get its own clip, the same one every retry", async () => {
  const short = video(1, 2, [mp4File(1080, 1920, "https://videos.pexels.com/short.mp4")]);
  const longs = [2, 3, 4, 5, 6].map((i) => video(i, 20, [mp4File(1080, 1920, `https://videos.pexels.com/long${i}.mp4`)]));
  const { f } = fake(() => json({ videos: [short, ...longs] }));
  const p = new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: never });
  const picks = new Set<string>();
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]) {
    const a = (await p.generate(scene({ id }))).url;
    assert.ok(!a.includes("short"), "a clip shorter than the scene is not preferred");
    assert.equal((await p.generate(scene({ id }))).url, a, "the same scene always gets the same clip");
    picks.add(a);
  }
  assert.ok(picks.size >= 3, `scenes vary: ${[...picks]}`);
});

await test("pexels: scenes that are not stock go to the fallback without touching the network", async () => {
  const { f, seen } = fake(() => json({}));
  const fb = fallbackUsed();
  const p = new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: fb.p });
  for (const source of ["image_gen", "video_gen", "upload"] as const) assert.equal((await p.generate(scene({ visual_source: source }))).provider, "fallback");
  assert.equal(fb.c.n, 3);
  assert.equal(seen.length, 0);
});

await test("pexels: results are cached, and our own hourly budget stops us before Pexels does", async () => {
  const t = { now: 1_000_000 };
  const { f, seen } = fake(() => json({ videos: [video(1, 10, [mp4File(1080, 1920, "https://videos.pexels.com/a.mp4")])] }));
  const p = new PexelsVisualProvider({ apiKey: "k", fetch: f, fallback: never, hourlyBudget: 4, now: () => t.now });
  await p.generate(scene());
  await p.generate(scene({ id: "s2" }));
  assert.equal(seen.length, 1, "the same search is answered from the cache");
  await p.generate(scene({ visual_prompt: "ocean waves sunset" }));
  await p.generate(scene({ visual_prompt: "mountain hiking trail" }));
  await p.generate(scene({ visual_prompt: "city skyline night" }));
  assert.equal(seen.length, 4);
  await assert.rejects(p.generate(scene({ visual_prompt: "coffee shop morning" })), (e: AdError) => e.code === "rate_limited" && e.retry === false && /Pexels searches/.test(e.message));
  assert.equal(seen.length, 4, "a refused call made no request");
  await p.generate(scene({ visual_prompt: "ocean waves sunset" }));
  assert.equal(seen.length, 4, "cached searches still work when the budget is spent");
  t.now += 3_700_000;
  await p.generate(scene({ visual_prompt: "coffee shop morning" }));
  assert.equal(seen.length, 5);
});

await test("pexels: errors name the setting to fix and never carry the key; short rate limits retry, hour-long ones do not", async () => {
  const run = (res: () => Response) => new PexelsVisualProvider({ apiKey: "PEXELS-SECRET-KEY", fetch: fake(res).f, fallback: never }).generate(scene());
  await assert.rejects(run(() => new Response("nope", { status: 401, headers: { "x-request-id": "req-77" } })), (e: AdError) => e.code === "provider_unavailable" && e.retry === false && /PEXELS_API_KEY/.test(e.message) && /req-77/.test(e.message) && !e.message.includes("PEXELS-SECRET-KEY"));
  await assert.rejects(run(() => new Response("", { status: 429, headers: { "retry-after": "5" } })), (e: AdError) => e.code === "rate_limited" && e.retry === true && e.retry_after === 5);
  await assert.rejects(run(() => new Response("", { status: 429, headers: { "retry-after": "3000" } })), (e: AdError) => e.code === "rate_limited" && e.retry === false && e.retry_after === 3000);
  await assert.rejects(run(() => new Response("", { status: 429, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 2400) } })), (e: AdError) => e.code === "rate_limited" && e.retry === false && e.retry_after! > 2000);
  await assert.rejects(run(() => new Response("", { status: 503 })), (e: AdError) => e.code === "provider_unavailable" && e.retry === true);
  await assert.rejects(run(() => new Response("<html>", { status: 200 })), (e: AdError) => e.code === "provider_unavailable" && /unreadable/.test(e.message));
  await assert.rejects(run(() => json({ videos: "not a list" })), (e: AdError) => e.code === "provider_unavailable" && /unexpected shape/.test(e.message));
  await assert.rejects(new PexelsVisualProvider({ apiKey: "k", fetch: (async () => { throw new Error("socket 10.0.0.1 closed"); }) as typeof fetch, fallback: never }).generate(scene()), (e: AdError) => /Could not reach Pexels\.$/.test(e.message), "the network error's details are not passed on");
  const slow = new PexelsVisualProvider({ apiKey: "k", timeoutMs: 20, fetch: ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as unknown as typeof fetch, fallback: never });
  await assert.rejects(slow.generate(scene()), /did not answer within/);
  const huge = new PexelsVisualProvider({ apiKey: "k", fetch: fake(() => new Response("x".repeat(3_000_000))).f, fallback: never });
  await assert.rejects(huge.generate(scene()), /larger than/);
});

// ============ OpenAI voice ============

const frame = Buffer.alloc(417);
frame.writeUInt32BE(0xfffb9064 >>> 0, 0);
const MP3 = Buffer.concat(Array.from({ length: 40 }, () => frame));
const audio = (body: Buffer = MP3, status = 200) => new Response(new Uint8Array(body), { status, headers: { "content-type": "audio/mpeg" } });

await test("voice: sends the line as JSON with a bearer key, returns the audio flagged as AI generated", async () => {
  const { f, seen } = fake(() => audio());
  const v = new OpenAIVoiceProvider({ apiKey: "sk-OPENAI-SECRET", fetch: f });
  const r = await v.generate(scene());
  assert.ok("audio" in r && r.audio.equals(MP3) && r.format === "mp3" && r.ai_generated === true && r.provider.startsWith("openai:"));
  assert.equal(r.voice, "alloy", "the voice name is reported");
  assert.equal(seen[0].url, "https://api.openai.com/v1/audio/speech");
  assert.equal(seen[0].init.method, "POST");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, "Bearer sk-OPENAI-SECRET");
  assert.deepEqual(JSON.parse(seen[0].init.body as string), { model: "gpt-4o-mini-tts", voice: "alloy", input: "Your weekend back, starting today.", response_format: "mp3" });
  const custom = fake(() => audio());
  await new OpenAIVoiceProvider({ apiKey: "k", fetch: custom.f, baseUrl: "https://gw.example/", model: "tts-x", voice: "verse" }).generate(scene());
  assert.equal(custom.seen[0].url, "https://gw.example/v1/audio/speech");
  assert.equal(JSON.parse(custom.seen[0].init.body as string).voice, "verse");
});

await test("voice: refuses empty or oversized lines before spending, and failures never carry the key or the text", async () => {
  const { f, seen } = fake(() => audio());
  const v = new OpenAIVoiceProvider({ apiKey: "sk-OPENAI-SECRET", fetch: f });
  await assert.rejects(v.generate(scene({ voiceover: "   " })), (e: AdError) => e.code === "invalid_input" && e.retry === false);
  await assert.rejects(v.generate(scene({ voiceover: "x".repeat(4097) })), (e: AdError) => e.code === "invalid_input" && /4096/.test(e.message));
  assert.equal(seen.length, 0, "a refused line made no request");
  const run = (res: Response) => new OpenAIVoiceProvider({ apiKey: "sk-OPENAI-SECRET", fetch: fake(() => res).f }).generate(scene({ voiceover: "Private customer sentence." }));
  await assert.rejects(run(new Response("{}", { status: 401, headers: { "x-request-id": "req_abc" } })), (e: AdError) => /OPENAI_API_KEY/.test(e.message) && /req_abc/.test(e.message) && !e.message.includes("sk-OPENAI") && e.retry === false);
  await assert.rejects(run(new Response("{}", { status: 400 })), (e: AdError) => e.code === "invalid_input" && !e.message.includes("Private customer"));
  await assert.rejects(run(new Response("", { status: 500 })), (e: AdError) => e.code === "provider_unavailable" && e.retry === true);
  await assert.rejects(run(audio(Buffer.from("tiny"))), /empty or truncated/);
});

// ============ ingestion and wiring ============

await test("ingest: audio a provider returns directly is checked like a download, stored under a server-chosen name, and junk is refused", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hookmint-voice-"));
  const ing = new MediaIngestor({ get: async () => { throw new Error("no network"); }, checkUrl() {} } as never, root);
  const file = await ing.audioBytes("acct_a", MP3, "mp3");
  assert.match(file, new RegExp(`^${root}/fetched/acct_a/[0-9a-f]{24}\\.mp3$`));
  await assert.rejects(ing.audioBytes("acct_a", Buffer.from("<html>not audio</html>".repeat(40)), "mp3"), /not a valid media file/);
  await assert.rejects(ing.audioBytes("../evil", MP3, "mp3"), /Unsafe account id/);
  assert.deepEqual(readdirSync(path.join(root, "fetched", "acct_a")).filter((x) => x.startsWith(".")), [], "refused audio leaves nothing behind");
});

await test("providers wired in: stock scenes get Pexels media and spoken lines get OpenAI audio, stored locally, with an AI voice notice and provenance", async () => {
  const assetDir = mkdtempSync(path.join(os.tmpdir(), "hookmint-prov-"));
  const jpeg = await sharp({ create: { width: 800, height: 450, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const pexels = fake(() => json({ photos: [photo(1, "https://images.pexels.com/photos/1/large2x.jpeg")] }));
  const openai = fake(() => audio());
  const downloads: string[] = [];
  const fetcher = { checkUrl() {}, get: async (url: string) => { downloads.push(url); return { bytes: jpeg, contentType: "image/jpeg", finalUrl: url }; } };
  const stub = createStubProviders({ delayMs: 5 });
  const seen: RenderArgs[] = [];
  const renderer: Renderer = { render: async (a) => { seen.push(a); return { url: "https://example.invalid/r.mp4" }; } };
  const providers = { ...stub, renderer, visual: new PexelsVisualProvider({ apiKey: "k", fetch: pexels.f, media: "photo", fallback: stub.visual }), voice: new OpenAIVoiceProvider({ apiKey: "k", fetch: openai.f }) };
  const service = newService(providers, { retryBaseMs: 5, limits: TEST_LIMITS, ingestor: new MediaIngestor(fetcher as never, assetDir) });
  const ctx = fullAccess("acct_a");
  await service.grantCredits(ctx.accountId, 500, "t");
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  const done = await waitForStatus(call, id, "completed", 10_000);
  const scenes = Object.keys(seen[0].assets);
  assert.ok(scenes.length >= 2);
  for (const s of scenes) {
    assert.match(seen[0].assets[s].visual_url, new RegExp(`^file://${assetDir}/fetched/acct_a/[0-9a-f]{24}\\.jpg$`), "stock photo became a local file");
    assert.match(seen[0].assets[s].voice_url, new RegExp(`^file://${assetDir}/fetched/acct_a/[0-9a-f]{24}\\.mp3$`), "synthetic voice became a local file");
  }
  assert.ok(downloads.every((u) => u.startsWith("https://images.pexels.com/")));
  assert.equal(openai.seen.length, scenes.length, "one speech request per scene");
  assert.match(done.renders[0].notes.join("\n"), /voiceover is AI-generated/);
  const prov = JSON.parse(seen[0].metadata!.description);
  assert.equal(prov.ai_voice, true, "the video's provenance says the voice is synthetic");
  assert.deepEqual(prov.voices, [{ provider: "openai:gpt-4o-mini-tts", voice: "alloy" }], "and names which synthetic voice, once");
  assert.match(done.renders[0].notes.join("\n"), /AI-generated \(openai:gpt-4o-mini-tts voice alloy\)/);
  assert.ok(pexels.seen.length >= 1 && pexels.seen.every((r) => r.url.startsWith("https://api.pexels.com/v1/search")), "photo mode searched photos only");
});

await test("providers wired in: the setup reads PEXELS_API_KEY and OPENAI_API_KEY, ignores shared base-URL variables, and says what is real", async () => {
  const none = createProviders({});
  assert.match(none.summary, /^stub providers/);
  const pexelsOnly = createProviders({ PEXELS_API_KEY: "p" });
  assert.ok(pexelsOnly.providers.visual instanceof StockChainVisualProvider);
  assert.ok(!(pexelsOnly.providers.voice instanceof OpenAIVoiceProvider));
  assert.match(pexelsOnly.summary, /Pexels/);
  const seenUrls: string[] = [];
  const spy = (async (u: string) => { seenUrls.push(String(u)); return audio(); }) as unknown as typeof fetch;
  const dir = mkdtempSync(path.join(os.tmpdir(), "hookmint-setup-"));
  const full = createProviders({ PEXELS_API_KEY: "p", OPENAI_API_KEY: "o", OPENAI_BASE_URL: "https://shared-gateway.example", HOOKMINT_RENDERER: "remotion", HOOKMINT_DATA_DIR: dir }, spy);
  assert.ok(full.providers.voice instanceof OpenAIVoiceProvider);
  assert.match(full.summary, /OpenAI text-to-speech/);
  await full.providers.voice.generate(scene());
  assert.deepEqual(seenUrls, ["https://api.openai.com/v1/audio/speech"], "OPENAI_BASE_URL is not read");
  const noStore = createProviders({ OPENAI_API_KEY: "o" });
  assert.ok(!(noStore.providers.voice instanceof OpenAIVoiceProvider), "without somewhere to keep audio the voice stays a stub");
  assert.match(noStore.summary, /needs HOOKMINT_RENDERER=remotion/);
  assert.ok(!full.summary.includes("o\"") && !JSON.stringify(full.summary).includes("OPENAI_API_KEY=o"));
});

// ============ Pixabay and the stock chain ============

const pxVideo = (id: number, duration: number, renditions: Record<string, { url: string; width: number; height: number }>) => ({ id, duration, videos: renditions });
const rend = (url: string, width: number, height: number) => ({ url, width, height });

await test("pixabay: key goes in the query only, never in cache keys or errors; picks the right shape, size and length", async () => {
  const { f, seen } = fake(() => json({ hits: [
    pxVideo(1, 12, { large: rend("https://cdn.pixabay.com/video/a-wide.mp4", 1920, 1080), medium: rend("https://cdn.pixabay.com/video/a-med.mp4", 1280, 720) }),
    pxVideo(2, 12, { large: rend("https://cdn.pixabay.com/video/b-tall.mp4", 1080, 1920), tiny: rend("https://cdn.pixabay.com/video/b-tiny.mp4", 320, 568), small: rend("https://cdn.pixabay.com/video/b-small.mp4", 640, 1138) }),
    pxVideo(3, 12, { large: rend("https://cdn.pixabay.com/video/c-4k.mp4", 3840, 2160) }),
  ] }));
  const p = new PixabayVisualProvider({ apiKey: "PIXABAY-SECRET-KEY", fetch: f, fallback: never });
  const r = await p.generate(scene());
  assert.deepEqual(r, { url: "https://cdn.pixabay.com/video/b-tall.mp4", provider: "pixabay", kind: "video" }, "the portrait clip wins for a portrait ad, at the largest size up to 1080");
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, "https://pixabay.com/api/videos/");
  assert.equal(u.searchParams.get("q"), "happy family relaxing bright clean living");
  assert.equal(u.searchParams.get("key"), "PIXABAY-SECRET-KEY");
  assert.equal(u.searchParams.get("safesearch"), "true");
  assert.equal(seen[0].init.redirect, "error");
  const wide = new PixabayVisualProvider({ apiKey: "k", fetch: f, fallback: never, orientation: "landscape" });
  assert.equal((await wide.generate(scene())).url, "https://cdn.pixabay.com/video/a-wide.mp4");
  const only4k = fake(() => json({ hits: [pxVideo(3, 12, { large: rend("https://cdn.pixabay.com/video/c-4k.mp4", 3840, 2160) })], }));
  await assert.rejects(new PixabayVisualProvider({ apiKey: "k", fetch: only4k.f, fallback: never, media: "video" }).generate(scene()), (e: AdError) => e.code === "not_found", "4K-only clips are not used, and photos are then tried");
});

await test("pixabay: photos map orientation, unexpected hosts are skipped, results are cached for a day, and our minute budget holds", async () => {
  const t = { now: 5_000_000 };
  const { f, seen } = fake(() => json({ hits: [{ id: 1, largeImageURL: "https://cdn.pixabay.com/photo/1.jpg" }, { id: 2, largeImageURL: "https://evil.example/2.jpg" }, { id: 3, largeImageURL: "http://cdn.pixabay.com/photo/3.jpg" }] }));
  const p = new PixabayVisualProvider({ apiKey: "k", fetch: f, fallback: never, media: "photo", perMinuteBudget: 2, now: () => t.now });
  const r = await p.generate(scene());
  assert.deepEqual(r, { url: "https://cdn.pixabay.com/photo/1.jpg", provider: "pixabay", kind: "image" });
  const u = new URL(seen[0].url);
  assert.equal(u.pathname, "/api/");
  assert.equal(u.searchParams.get("orientation"), "vertical");
  assert.equal(u.searchParams.get("image_type"), "photo");
  await p.generate(scene({ id: "s2" }));
  assert.equal(seen.length, 1, "cached");
  await p.generate(scene({ visual_prompt: "ocean waves sunset" }));
  await assert.rejects(p.generate(scene({ visual_prompt: "mountain hiking trail" })), (e: AdError) => e.code === "rate_limited" && e.retry === false && /Pixabay searches/.test(e.message));
  assert.equal(seen.length, 2);
  t.now += 61_000;
  await p.generate(scene({ visual_prompt: "mountain hiking trail" }));
  assert.equal(seen.length, 3, "the budget refills after a minute");
  t.now += 25 * 3_600_000;
  await p.generate(scene());
  assert.equal(seen.length, 4, "a day later the cache has expired");
  const fb = fallbackUsed();
  assert.equal((await new PixabayVisualProvider({ apiKey: "k", fetch: f, fallback: fb.p }).generate(scene({ visual_source: "image_gen" }))).provider, "fallback");
});

await test("pixabay: errors name the setting to fix and never carry the key or the address that contained it", async () => {
  const run = (res: () => Response) => new PixabayVisualProvider({ apiKey: "PIXABAY-SECRET-KEY", fetch: fake(res).f, fallback: never }).generate(scene());
  await assert.rejects(run(() => new Response("[ERROR 400] Invalid key", { status: 400 })), (e: AdError) => e.code === "invalid_input" && !e.message.includes("PIXABAY-SECRET") && !/Invalid key/.test(e.message));
  await assert.rejects(run(() => new Response("", { status: 401 })), (e: AdError) => /PIXABAY_API_KEY/.test(e.message) && e.retry === false);
  await assert.rejects(run(() => new Response("", { status: 429, headers: { "retry-after": "20" } })), (e: AdError) => e.code === "rate_limited" && e.retry_after === 20 && e.retry === true);
  await assert.rejects(run(() => json({ hits: "nope" })), /unexpected shape/);
  await assert.rejects(new PixabayVisualProvider({ apiKey: "PIXABAY-SECRET-KEY", fetch: (async () => { throw new Error("fetch failed for https://pixabay.com/api/?key=PIXABAY-SECRET-KEY"); }) as typeof fetch, fallback: never }).generate(scene()), (e: AdError) => !e.message.includes("PIXABAY-SECRET") && /Could not reach Pixabay/.test(e.message), "a network error's text, which can contain the address, is dropped");
});

await test("stock chain: the next provider is tried when one has nothing, is over budget or is down; real mistakes stop the chain", async () => {
  const calls: string[] = [];
  const mk = (name: string, outcome: "ok" | AdError) => ({ name, provider: { generate: async (s: Scene) => { calls.push(name); if (outcome !== "ok") throw outcome; return { url: `https://${name}.example/${s.id}.mp4`, provider: name, kind: "video" as const }; } } as VisualProvider });
  const fb = fallbackUsed();
  const empty = new AdError("not_found", "nothing", undefined, { retry: false });
  const chain = new StockChainVisualProvider([mk("a", empty), mk("b", "ok")], fb.p);
  assert.equal((await chain.generate(scene())).provider, "b");
  assert.deepEqual(calls, ["a", "b"]);
  calls.length = 0;
  assert.equal((await new StockChainVisualProvider([mk("a", new AdError("rate_limited", "budget", 60, { retry: false })), mk("b", "ok")], fb.p).generate(scene())).provider, "b");
  assert.equal((await new StockChainVisualProvider([mk("a", new AdError("provider_unavailable", "down")), mk("b", "ok")], fb.p).generate(scene())).provider, "b");
  calls.length = 0;
  await assert.rejects(new StockChainVisualProvider([mk("a", new AdError("invalid_input", "bad scene", undefined, { retry: false })), mk("b", "ok")], fb.p).generate(scene()), (e: AdError) => e.code === "invalid_input");
  assert.deepEqual(calls, ["a"], "a mistake in the request is not retried elsewhere");
  await assert.rejects(new StockChainVisualProvider([mk("a", empty), mk("b", new AdError("provider_unavailable", "down"))], fb.p).generate(scene()), (e: AdError) => e.code === "provider_unavailable" && /a: nothing/.test(e.message) && /b: down/.test(e.message));
  assert.equal((await chain.generate(scene({ visual_source: "upload" }))).provider, "fallback", "non-stock scenes skip the chain");
  assert.equal(fb.c.n, 1);
  await assert.rejects(new StockChainVisualProvider([mk("a", empty)], fb.p).generate(scene()), (e: AdError) => e.code === "not_found", "a single provider reports its own error");
  assert.throws(() => new StockChainVisualProvider([], fb.p), /at least one/);
});

await test("providers wired in: both stock keys make a chain in order, and PIXABAY_API_KEY alone works", async () => {
  const both = createProviders({ PEXELS_API_KEY: "p", PIXABAY_API_KEY: "x" });
  assert.ok(both.providers.visual instanceof StockChainVisualProvider);
  assert.match(both.summary, /Pexels then Pixabay stock footage/);
  const only = createProviders({ PIXABAY_API_KEY: "x" });
  assert.ok(only.providers.visual instanceof StockChainVisualProvider);
  assert.match(only.summary, /Pixabay stock footage/);
  assert.ok(!/Pexels/.test(only.summary));
  const urls: string[] = [];
  const spy = (async (u: string) => { urls.push(String(u)); return json({ hits: [{ id: 1, largeImageURL: "https://cdn.pixabay.com/photo/1.jpg" }] }); }) as unknown as typeof fetch;
  const photoMode = createProviders({ PIXABAY_API_KEY: "x", HOOKMINT_PEXELS_MEDIA: "photo", HOOKMINT_PIXABAY_BASE_URL: "https://gw.example" }, spy);
  assert.equal((await photoMode.providers.visual.generate(scene())).provider, "pixabay");
  assert.ok(urls[0].startsWith("https://gw.example/api/"), "the base URL is configurable");
});

console.log(`providers: ${n} tests passed`);
process.exit(0);
