process.env.STUB_DELAY_MS = "5";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { RenderInternals } from "@remotion/renderer";
import { fullAccess } from "../src/core/context.js";
import { DownloadSigner } from "../src/core/downloads.js";
import { AdService } from "../src/core/service.js";
import type { ScenePlan } from "../src/core/schemas.js";
import type { Renderer } from "../src/providers/types.js";
import { createStubProviders } from "../src/providers/stub.js";
import { AssetServer, MAX_ASSET_BYTES, resolveLocalAsset } from "../src/render/assets.js";
import * as L from "../src/render/layout.js";
import { brandProps, findBrowser, RemotionRenderer, RENDERER_VERSION, withRendererFacts } from "../src/render/remotion.js";
import { createApp } from "../src/server/app.js";
import { connect, key, newReadyAd, sleep, waitForStatus } from "./helpers.js";

const run = promisify(execFile);
let n = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  await fn();
  n++;
  console.log("  ok", name);
};
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `hookmint-${p}-`));

const plan = (over: Partial<ScenePlan> = {}): ScenePlan => ({
  schema_version: "1.1", template: { id: "default", version: "1.0.0" }, hook: "Your weekend back, starting today", hook_id: "h_test", angle: "convenience", variant_group_id: "vg_test",
  cta: { text: "Book your clean today" }, aspect_ratios: ["9:16"],
  scenes: [
    { id: "s1", duration_s: 2, visual_prompt: "kitchen", visual_source: "stock", voiceover: "Tired of scrubbing floors all Saturday?", on_screen_text: "Your weekend back", claims: [] },
    { id: "s2", duration_s: 2, visual_prompt: "crew", visual_source: "stock", voiceover: "Our local crew handles the deep clean.", claims: [] },
  ],
  ...over,
});
const lite = (p: ScenePlan): L.PlanLite => ({ hook: p.hook, cta: p.cta, scenes: p.scenes });

// ============ pure checks: always run, no browser ============

await test("layout: frames, safe areas and text sizes are consistent for all three shapes", async () => {
  for (const a of L.ASPECTS) {
    const { width, height } = L.DIMENSIONS[a];
    const r = L.safeRect(a);
    assert.ok(r.x > 0 && r.y > 0 && r.x + r.width < width && r.y + r.height < height, `${a} safe area sits inside the frame`);
    const s = L.sizes(a);
    assert.ok(s.caption >= s.captionMin && s.headline >= s.headlineMin);
  }
  assert.deepEqual([L.DIMENSIONS["9:16"], L.DIMENSIONS["1:1"], L.DIMENSIONS["16:9"]].map((d) => `${d.width}x${d.height}`), ["1080x1920", "1080x1080", "1920x1080"]);
  const tall = L.safeRect("9:16");
  assert.ok(tall.y >= 1920 * 0.14 - 1 && 1920 - (tall.y + tall.height) >= 1920 * 0.22 - 1, "9:16 keeps clear of the platform interface at top and bottom");
});

await test("timeline: scenes tile the video exactly with no gaps, and the call to action fits inside the last scene", async () => {
  const p = lite(plan({ scenes: [{ ...plan().scenes[0], duration_s: 3.3 }, { ...plan().scenes[1], duration_s: 4.1 }, { ...plan().scenes[1], id: "s3", duration_s: 5 }] }));
  const t = L.buildTimeline(p);
  assert.equal(t.totalFrames, Math.round(12.4 * L.FPS));
  let at = 0;
  for (const s of t.scenes) { assert.equal(s.startFrame, at); at += s.durationFrames; }
  assert.equal(at, t.totalFrames);
  assert.ok(t.scenes[0].isFirst && t.scenes.at(-1)!.isLast);
  for (const frames of [1, 2, 10, 30, 60, 90, 300]) {
    const w = L.ctaWindow(frames);
    assert.ok(w.durationFrames >= 1 && w.startFrame >= 0 && w.startFrame + w.durationFrames === frames);
    assert.ok(w.durationFrames <= Math.max(1, Math.floor(frames / 2)) && w.durationFrames <= 75);
  }
});

await test("text fitting: short text keeps its size, long text shrinks, and what cannot fit is flagged", async () => {
  const r = L.safeRect("9:16"); const s = L.sizes("9:16");
  const short = L.fitText("Book today", r.width, 3, s.headline, s.headlineMin);
  assert.equal(short.fontSize, s.headline); assert.equal(short.truncated, false);
  const medium = L.fitText("Your weekend back, starting today and every Saturday after that", r.width, 3, s.headline, s.headlineMin);
  assert.ok(medium.fontSize < s.headline && medium.fontSize >= s.headlineMin);
  const huge = L.fitText("word ".repeat(120), r.width, 3, s.headline, s.headlineMin);
  assert.equal(huge.fontSize, s.headlineMin); assert.equal(huge.truncated, true);
  assert.equal(L.estimateLines("x".repeat(5000), 80, 900) > 3, true); // one enormous word still counts as many lines
});

await test("colours: only plain hex gets into the template, and chosen text colours meet 4.5:1 contrast", async () => {
  for (const bad of ["red; background:url(//evil)", "#12", "javascript:alert(1)", "#GGGGGG", "var(--x)", "#" + "a".repeat(40), "rgb(1,2,3)", "", undefined, null]) {
    assert.equal(L.sanitizeColor(bad as string, "#0a84ff"), "#0a84ff", String(bad));
  }
  assert.equal(L.sanitizeColor("#ABC", "#000000"), "#aabbcc");
  assert.equal(L.sanitizeColor("  #FFD60A ", "#000000"), "#ffd60a");
  assert.ok(Math.abs(L.contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 1e-9);
  assert.ok(Math.abs(L.contrastRatio([255, 255, 255], [119, 119, 119]) - 4.48) < 0.02);
  let worst = Infinity;
  for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
    const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    const text = L.pickTextColor(hex);
    worst = Math.min(worst, L.contrastRatio(L.rgb(hex), L.rgb(text)));
  }
  assert.ok(worst >= 4.5, `worst chosen contrast ${worst.toFixed(2)}`);
  assert.ok(L.captionContrast(L.CAPTION_SCRIM) >= 4.5, "white caption text stays readable even over pure white video");
  assert.deepEqual(brandProps({ id: "b", name: "N".repeat(100), colors: ["not a colour"] }), { name: "N".repeat(40), primary: "#0a84ff", secondary: L.darken("#0a84ff") });
  assert.equal(brandProps(undefined).name, "");
});

await test("provenance: the renderer records the template and version it actually used, and leaves other metadata alone", async () => {
  assert.equal(withRendererFacts(undefined), null);
  const m = withRendererFacts({ title: "T", description: JSON.stringify({ ai_generated: true, template: { id: "stub", version: "0" } }) })!;
  assert.equal(m.title, "T");
  assert.deepEqual(JSON.parse(m.description), { ai_generated: true, template: { id: "default", version: "1.0.0" }, rendered_with: RENDERER_VERSION });
  assert.deepEqual(withRendererFacts({ description: "plain text" }), { description: "plain text" });
  assert.deepEqual(withRendererFacts({ title: "only a title" }), { title: "only a title" });
  assert.deepEqual(withRendererFacts({ description: "[1,2]" }), { description: "[1,2]" });
});

await test("readability notes: fast captions, over-long text and a long button label are called out; a normal plan is quiet", async () => {
  assert.deepEqual(L.readabilityNotes(lite(plan()), "9:16"), []);
  const fast = plan({ scenes: [{ ...plan().scenes[0], duration_s: 2, voiceover: "one two three four five six seven eight nine ten eleven twelve" }, plan().scenes[1]] });
  assert.match(L.readabilityNotes(lite(fast), "9:16").join(" "), /Scene s1: .*12 words in 2s .*faster than most people can read/);
  const wordy = plan({ scenes: [{ ...plan().scenes[0], on_screen_text: "word ".repeat(80) }, plan().scenes[1]] });
  assert.match(L.readabilityNotes(lite(wordy), "9:16").join(" "), /on-screen text is too long/);
  const cta = plan({ cta: { text: "Click here to book your appointment online right now and save " .repeat(3) } });
  assert.match(L.readabilityNotes(lite(cta), "1:1").join(" "), /call to action is too long/);
});

await test("download links: bound to one render, one account and one expiry; tampering and expiry are refused", async () => {
  const s = new DownloadSigner({ secret: "x".repeat(40), baseUrl: "https://api.example.com/", ttlSeconds: 600 });
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  const link = s.sign("acct_a", "rn_1", now);
  assert.equal(link.ttl_s, 600);
  assert.equal(link.expires_at, new Date(now + 600_000).toISOString());
  const u = new URL(link.url);
  assert.equal(u.origin + u.pathname, "https://api.example.com/files/rn_1");
  const p = (over: Record<string, string | null> = {}) => ({ renderId: "rn_1", acct: u.searchParams.get("acct"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig"), ...over });
  assert.equal(s.verify(p(), now + 1000), "ok");
  assert.equal(s.verify(p(), now + 599_000), "ok");
  assert.equal(s.verify(p(), now + 601_000), "expired");
  assert.equal(s.verify(p({ renderId: "rn_2" }), now), "invalid");
  assert.equal(s.verify(p({ acct: "acct_b" }), now), "invalid");
  assert.equal(s.verify(p({ exp: String(Number(u.searchParams.get("exp")) + 3600) }), now), "invalid", "cannot extend the expiry");
  assert.equal(s.verify(p({ sig: "A".repeat(43) }), now), "invalid");
  assert.equal(s.verify(p({ sig: null }), now), "invalid");
  assert.equal(s.verify(p({ exp: "abc" }), now), "invalid");
  assert.equal(new DownloadSigner({ secret: "y".repeat(40) }).verify(p(), now), "invalid", "another secret cannot verify it");
  assert.throws(() => new DownloadSigner({ secret: "short" }), /at least 32/);
  assert.equal(new DownloadSigner().ephemeral, true);
  assert.equal(s.ephemeral, false);
  assert.equal(new DownloadSigner().ttlSeconds, 900);
});

await test("asset resolver: only local files inside the asset folder, of allowed types, in the right role", async () => {
  const root = tmp("assets"); const outside = tmp("outside");
  const f = (name: string, bytes = "x") => { const p = path.join(root, name); writeFileSync(p, bytes); return `file://${p}`; };
  writeFileSync(path.join(outside, "secret.png"), "x");
  symlinkSync(path.join(outside, "secret.png"), path.join(root, "link.png"));
  assert.deepEqual(await resolveLocalAsset(f("a.png"), root, "visual"), { ok: true, path: await fs.realpath(path.join(root, "a.png")), kind: "image" });
  assert.equal((await resolveLocalAsset(f("b.mp4"), root, "visual") as { kind: string }).kind, "video");
  assert.equal((await resolveLocalAsset(f("c.wav"), root, "voice") as { kind: string }).kind, "audio");
  const reject = async (url: string | undefined, want: "visual" | "voice", re: RegExp) => {
    const r = await resolveLocalAsset(url, root, want);
    assert.equal(r.ok, false, String(url));
    assert.match((r as { reason: string }).reason, re, String(url));
  };
  await reject(undefined, "visual", /no file/);
  await reject("https://example.com/a.png", "visual", /does not fetch remote media/);
  await reject("http://169.254.169.254/latest/meta-data", "visual", /does not fetch remote media/);
  await reject("https://example.invalid/assets/s1.mp4", "visual", /does not fetch remote media/);
  await reject("file:///etc/passwd", "visual", /outside the allowed asset folder|not allowed/);
  await reject(`file://${root}/../${path.basename(outside)}/secret.png`, "visual", /outside the allowed asset folder|not found/);
  await reject(`file://${path.join(root, "link.png")}`, "visual", /outside the allowed asset folder/); // symlink out of the folder
  await reject(f("d.txt"), "visual", /file type is not allowed/);
  await reject(f("e.svg"), "visual", /file type is not allowed/);
  await reject(f("f.exe"), "visual", /file type is not allowed/);
  await reject(f("g.wav"), "visual", /audio file cannot be used as the visual/);
  await reject(f("h.png"), "voice", /image file cannot be used as the voice/);
  await reject(`file://${path.join(root, "missing.png")}`, "visual", /not found/);
  await fs.mkdir(path.join(root, "dir.png")); await reject(`file://${path.join(root, "dir.png")}`, "visual", /not a regular file/);
  const big = path.join(root, "big.mp4"); await fs.writeFile(big, ""); await fs.truncate(big, MAX_ASSET_BYTES + 1);
  await reject(`file://${big}`, "visual", /too large/);
});

await test("asset server: serves only registered files, supports ranges, and offers nothing to traverse", async () => {
  const root = tmp("srv"); const file = path.join(root, "clip.mp4"); const body = Buffer.from("0123456789abcdefghij"); writeFileSync(file, body);
  writeFileSync(path.join(root, "other.mp4"), "not registered");
  const srv = new AssetServer(); await srv.start();
  try {
    const url = srv.register(file);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/a\/[a-f0-9]{32}\.mp4$/);
    const full = await fetch(url);
    assert.equal(full.status, 200); assert.equal(full.headers.get("access-control-allow-origin"), "*"); assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);
    const part = await fetch(url, { headers: { range: "bytes=5-9" } });
    assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), "bytes 5-9/20");
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), "56789");
    const tail = await fetch(url, { headers: { range: "bytes=-4" } });
    assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), "ghij");
    assert.equal((await fetch(url, { headers: { range: "bytes=500-600" } })).status, 416);
    assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
    const base = new URL(url).origin;
    for (const bad of ["/a/other.mp4", "/a/../etc/passwd", "/a/%2e%2e%2fetc%2fpasswd", `/a/${"0".repeat(32)}.mp4`, "/", `/${path.basename(file)}`]) {
      assert.equal((await fetch(base + bad)).status, 404, bad);
    }
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
    const port = new URL(url).port;
    await srv.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/a/x.mp4`), /fetch failed/);
  } finally {
    await srv.close().catch(() => {});
  }
});

await test("a render that finishes after the ad was cancelled is deleted, and nothing about it is kept", async () => {
  const dir = tmp("cancel");
  let wrote = "";
  const slow: Renderer = {
    async render({ outputPath }) {
      await sleep(150);
      wrote = outputPath!; await fs.writeFile(wrote, "fake video");
      return { file: { bytes: 10, duration_s: 4 }, notes: [], renderer_version: "fake" };
    },
  };
  const service = new AdService({ ...createStubProviders({ delayMs: 5 }), renderer: slow }, { renderDir: dir, retryBaseMs: 5 });
  const ctx = fullAccess("acct_a"); service.grantCredits(ctx.accountId, 100, "t");
  const { call } = await connect(service, ctx);
  const id = await newReadyAd(call);
  const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
  await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
  for (let i = 0; i < 100 && service.getAd(ctx, id).status !== "rendering"; i++) await sleep(5);
  await call("cancel_ad", { job_id: id });
  await sleep(500);
  assert.ok(wrote, "the renderer did run");
  await assert.rejects(fs.access(wrote), "the file must be gone");
  assert.equal(service.store.renders.size, 0);
  assert.equal(service.getAd(ctx, id).renders.length, 0);
  assert.equal(service.getBalance(ctx).held, 0);
});

// ============ browser checks ============

const browser = findBrowser();
if (!browser) {
  if (process.env.HOOKMINT_REQUIRE_RENDER === "1") throw new Error("HOOKMINT_REQUIRE_RENDER=1 but no Chrome or Chromium was found");
  console.log("\n  SKIPPED: browser render checks (no Chrome or Chromium found; set HOOKMINT_BROWSER, or HOOKMINT_REQUIRE_RENDER=1 to make this a failure)");
  console.log(`render passed: ${n} checks (browser checks skipped)`);
  process.exit(0);
}

const assetRoot = tmp("render-assets"); const outDir = tmp("render-out");
const renderer = new RemotionRenderer({ assetRoot });
const ffprobe = RenderInternals.getExecutablePath({ type: "ffprobe", indent: false, logLevel: "error", binariesDirectory: null });
const probe = async (file: string) => JSON.parse((await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])).stdout) as { streams: Record<string, any>[]; format: { tags?: Record<string, string>; duration: string } };
const pixels = async (file: string) => PNG.sync.read(await fs.readFile(file));
const brand = { id: "b", name: "Sparkle Cleaning Co", colors: ["#0a84ff"] };
console.log(`\n  (browser checks use ${browser})`);

await test("render: a real MP4 with the right size, length, frame count and no sound when there is no audio", async () => {
  const out = path.join(outDir, "a.mp4");
  const r = await renderer.render({ plan: plan(), aspect: "9:16", assets: {}, brand, outputPath: out, metadata: { title: "T", description: JSON.stringify({ ai_generated: true, ad_id: "ad_x" }) } });
  const info = await probe(out);
  const v = info.streams.find((s) => s.codec_type === "video")!;
  assert.equal(v.codec_name, "h264"); assert.equal(v.width, 1080); assert.equal(v.height, 1920);
  assert.equal(Number(v.nb_frames), 120);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.1);
  assert.equal(info.streams.some((s) => s.codec_type === "audio"), false);
  assert.equal(r.file!.bytes, (await fs.stat(out)).size);
  assert.equal(r.file!.duration_s, 4);
  assert.equal(r.renderer_version, RENDERER_VERSION);
  assert.match(r.notes!.join(" "), /No usable visual for scenes s1, s2/);
  assert.match(r.notes!.join(" "), /no sound/);
  const tags = info.format.tags ?? {};
  assert.equal(tags.title, "T");
  assert.deepEqual(JSON.parse(tags.description), { ai_generated: true, ad_id: "ad_x", template: { id: "default", version: "1.0.0" }, rendered_with: RENDERER_VERSION });
});

await test("render: all three shapes come out at the right size", async () => {
  for (const [aspect, w, h] of [["1:1", 1080, 1080], ["16:9", 1920, 1080]] as const) {
    const out = path.join(outDir, `${aspect.replace(":", "x")}.mp4`);
    await renderer.render({ plan: plan(), aspect, assets: {}, brand, outputPath: out });
    const v = (await probe(out)).streams.find((s) => s.codec_type === "video")!;
    assert.deepEqual([v.width, v.height], [w, h], aspect);
  }
});

/** Any pixel brighter than this, outside the safe area, means text or a box was painted where it should not be. */
const LIT = 48;
function scan(png: PNG, rect: L.Rect) {
  let outside = 0, inside = 0, first = "";
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) <= LIT) continue;
    const inRect = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    if (inRect) inside++; else { outside++; first ||= `(${x},${y})`; }
  }
  return { outside, inside, first };
}

await test("safe areas: nothing is painted outside them, in every shape, at the start and at the call to action", async () => {
  const stress = plan({
    hook: "h", cta: { text: "Call us today to book your full deep clean and get a free quote on the spot" },
    scenes: [
      { id: "s1", duration_s: 3, visual_prompt: "x", visual_source: "stock", voiceover: "A very long caption that keeps going. ".repeat(14), on_screen_text: "An extremely long headline that will not fit unless it shrinks and then still gets shortened ".repeat(3), claims: [] },
      { id: "s2", duration_s: 3, visual_prompt: "x", visual_source: "stock", voiceover: "Short.", claims: [] },
    ],
  });
  for (const aspect of L.ASPECTS) {
    const rect = L.safeRect(aspect);
    for (const [label, p] of [["normal", plan()], ["stress", stress]] as const) {
      const total = L.buildTimeline(lite(p)).totalFrames;
      for (const [moment, frame] of [["opening", 20], ["call to action", total - 5]] as const) {
        const file = path.join(outDir, `probe-${aspect.replace(":", "x")}-${label}-${moment.replace(/ /g, "")}.png`);
        await renderer.probeStill({ plan: p, aspect, brand }, frame, file);
        const r = scan(await pixels(file), rect);
        assert.equal(r.outside, 0, `${aspect} ${label} ${moment}: ${r.outside} lit pixels outside the safe area, first at ${r.first}`);
        assert.ok(r.inside > 800, `${aspect} ${label} ${moment}: expected visible text inside the safe area, found ${r.inside} lit pixels`);
      }
    }
  }
});

await test("media: a local image and voiceover are used, and only the scene that lacks them falls back", async () => {
  const img = new PNG({ width: 64, height: 36 });
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 200; img.data[i + 1] = 30; img.data[i + 2] = 30; img.data[i + 3] = 255; }
  await fs.writeFile(path.join(assetRoot, "red.png"), PNG.sync.write(img));
  const sr = 8000; const samples = sr; const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), 44 + i * 2);
  await fs.writeFile(path.join(assetRoot, "tone.wav"), wav);
  const assets = { s1: { visual_url: `file://${path.join(assetRoot, "red.png")}`, voice_url: `file://${path.join(assetRoot, "tone.wav")}` }, s2: { visual_url: "https://example.invalid/s2.mp4", voice_url: "https://example.invalid/s2.mp3" } };

  const out = path.join(outDir, "media.mp4");
  const r = await renderer.render({ plan: plan(), aspect: "9:16", assets, brand, outputPath: out });
  const info = await probe(out);
  assert.ok(info.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), "voiceover became an audio track");
  assert.match(r.notes!.join(" "), /No usable visual for scene s2;/);
  assert.doesNotMatch(r.notes!.join(" "), /scenes? s1[,;]/);
  assert.match(r.notes!.join(" "), /No voiceover audio for scene s2;/);

  const still = path.join(outDir, "media-still.png");
  await renderer.still({ plan: plan(), aspect: "9:16", assets, brand }, 10, still);
  const png = await pixels(still);
  const at = (x: number, y: number) => { const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
  const [red, , blue] = at(40, 140); // inside scene 1, away from text
  assert.ok(red > 110 && blue < 70, `scene 1 shows the red image, got rgb ${at(40, 140)}`);
  const fallback = path.join(outDir, "media-still-s2.png");
  await renderer.still({ plan: plan(), aspect: "9:16", assets, brand }, 80, fallback);
  const png2 = await pixels(fallback);
  const j = (140 * png2.width + 40) * 4;
  assert.ok(png2.data[j + 2] > png2.data[j], `scene 2 falls back to the blue brand gradient, got rgb ${[png2.data[j], png2.data[j + 1], png2.data[j + 2]]}`);
});

await test("media: a local video clip is used as a scene background", async () => {
  // Make a clip with the renderer itself, in green, so it is easy to tell apart from the blue fallback gradient.
  const clip = path.join(assetRoot, "green.mp4");
  await renderer.render({ plan: plan({ scenes: [{ ...plan().scenes[0], duration_s: 1 }, { ...plan().scenes[1], duration_s: 1 }] }), aspect: "9:16", assets: {}, brand: { id: "g", name: "Clip", colors: ["#18a058"] }, outputPath: clip });
  const assets = { s1: { visual_url: `file://${clip}`, voice_url: "" } };
  const still = path.join(outDir, "video-still.png");
  await renderer.still({ plan: plan(), aspect: "9:16", assets, brand }, 20, still);
  const png = await pixels(still);
  const i = (700 * png.width + 40) * 4; // inside scene 1, away from text, where the clip's gradient shows
  const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
  assert.ok(g > b && g > r, `scene 1 shows the green clip, not the blue brand gradient; got rgb ${[r, g, b]}`);
  const fallback = path.join(outDir, "video-still-s2.png");
  await renderer.still({ plan: plan(), aspect: "9:16", assets, brand }, 80, fallback);
  const p2 = await pixels(fallback);
  const j = (700 * p2.width + 40) * 4;
  assert.ok(p2.data[j + 2] > p2.data[j + 1], "scene 2 has no clip, so it uses the blue brand gradient");
});

await test("end to end: approve renders real files; fresh signed links download them; bad or expired links are refused", async () => {
  const dir = tmp("e2e");
  const signer = new DownloadSigner({ secret: "z".repeat(40), baseUrl: "http://127.0.0.1:0", ttlSeconds: 900 });
  const service = new AdService({ ...createStubProviders({ delayMs: 5 }), renderer }, { renderDir: dir, retryBaseMs: 5, downloads: signer });
  const ctx = fullAccess("acct_a"); service.grantCredits(ctx.accountId, 200, "t");
  const server = createApp(service, { apiKeys: new Map([["k", ctx]]) }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Rebuild the signer with the real port now that the server is listening.
  (service as unknown as { downloads: DownloadSigner }).downloads = new DownloadSigner({ secret: "z".repeat(40), baseUrl: base, ttlSeconds: 900 });
  (service as unknown as { opts: { downloads: DownloadSigner } }).opts.downloads = service.downloads;
  try {
    const { call } = await connect(service, ctx);
    const id = await newReadyAd(call, { aspect_ratios: ["9:16", "1:1"], duration_s: 15 });
    const est = (await call("estimate_cost", { job_id: id })).json.credits as number;
    await call("approve_and_render", { job_id: id, max_credits: est, idempotency_key: key() });
    const done = await waitForStatus(call, id, "completed", 180_000); // two real 15-second renders
    assert.equal(done.renders.length, 2);
    const r = done.renders.find((x: { aspect_ratio: string }) => x.aspect_ratio === "9:16");
    assert.match(r.render_id, /^rn_[0-9a-f]{12}$/);
    assert.ok(r.url.startsWith(`${base}/files/${r.render_id}?`));
    assert.ok(new Date(r.expires_at).getTime() > Date.now());
    assert.ok(r.bytes > 1000 && r.renderer_version === RENDERER_VERSION && Array.isArray(r.notes));
    assert.equal(r.local_path, undefined);
    for (const stored of service.getAd(ctx, id).renders) assert.equal(JSON.stringify(stored).includes("sig="), false, "links are never stored");

    const res = await fetch(r.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, r.bytes);
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
    assert.equal((await fetch(r.url, { headers: { range: "bytes=0-99" } })).status, 206);
    assert.equal((await fetch(r.url, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(r.url, { method: "POST" })).status, 405);

    const u = new URL(r.url);
    const bad = (mut: (q: URLSearchParams) => void) => { const q = new URLSearchParams(u.search); mut(q); return `${u.origin}${u.pathname}?${q}`; };
    assert.equal((await fetch(bad((q) => q.set("sig", "A".repeat(43))))).status, 403);
    assert.equal((await fetch(bad((q) => q.set("acct", "acct_b")))).status, 403);
    assert.equal((await fetch(bad((q) => q.set("exp", String(Number(q.get("exp")) + 3600))))).status, 403);
    assert.equal((await fetch(bad((q) => q.delete("sig")))).status, 403);
    assert.equal((await fetch(`${base}/files/${r.render_id}`)).status, 403);
    const missing = service.downloads.sign("acct_a", "rn_doesnotexist");
    assert.equal((await fetch(missing.url)).status, 404);
    const stranger = service.downloads.sign("acct_b", r.render_id); // validly signed, but the render is not theirs
    assert.equal((await fetch(stranger.url)).status, 404);

    const expiring = new DownloadSigner({ secret: "z".repeat(40), baseUrl: base, ttlSeconds: 1 });
    const short = expiring.sign("acct_a", r.render_id);
    assert.equal((await fetch(short.url)).status, 200);
    await sleep(2100);
    const late = await fetch(short.url);
    assert.equal(late.status, 403);
    assert.match(await late.text(), /expired/);

    const fresh = await call("get_download_url", { render_id: r.render_id });
    assert.equal(fresh.isError, false, fresh.text);
    assert.equal((await fetch(fresh.json.url)).status, 200);
    assert.equal(fresh.json.ttl_s, 900);
    const other = await connect(service, fullAccess("acct_b"));
    assert.match((await other.call("get_download_url", { render_id: r.render_id })).text, /^\[not_found\]/);
    assert.match((await call("get_download_url", { render_id: "rn_nope" })).text, /^\[not_found\]/);
    const rest = await fetch(`${base}/v1/renders/${r.render_id}/download-url`, { headers: { authorization: "Bearer k" } });
    assert.equal(rest.status, 200);
    assert.equal((await fetch(`${base}/v1/renders/${r.render_id}/download-url`)).status, 403, "the REST route needs the API key");

    const info = await probe(path.join(dir, `${r.render_id}.mp4`));
    const prov = JSON.parse(info.format.tags!.description);
    assert.equal(prov.ai_generated, true); assert.equal(prov.generator, "hookmint"); assert.equal(prov.ad_id, id);
    assert.equal(prov.plan_version, 1); assert.deepEqual(prov.template, { id: "default", version: "1.0.0" }, "the template actually used, not the one the stub plan named");
    assert.equal(prov.rendered_with, RENDERER_VERSION);
    assert.match(r.notes.join(" "), /plan names template stub@0\.0\.0, but this renderer only has default@1\.0\.0/);
    assert.match(prov.hook_id, /^h_/);
    assert.equal(info.format.tags!.title, "Hookmint ad");
    assert.ok(Math.abs(Number(info.format.duration) - 15) < 0.2);
  } finally {
    server.close();
  }
});

console.log(`render passed: ${n} checks`);
process.exit(0);
