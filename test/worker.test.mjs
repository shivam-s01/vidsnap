// Offline tests — fetch mock hai, koi real site hit nahi hoti.
// Ye parsing/signing/proxy ka logic verify karte hain, platforms ki live availability nahi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { signProxy, verifyProxy, unescapeUrl, isBlockedHost, platformOf } from "../src/lib.js";

const ENV = {
  PROXY_SECRET: "s".repeat(40), TERABOX_COOKIE: "ndus=test", LEGACY_BACKEND: "https://legacy.test",
  ASSETS: { fetch: async () => new Response("static", { status: 200 }) },
};
const CTX = { waitUntil() {} };
const ORIGIN = "https://vidsnap.test";

let routes = [];       // [matcher, handler]
let calls = [];        // {url, init}
const realFetch = globalThis.fetch;

function mock(matcher, handler) { routes.push([matcher, handler]); }
function withUrl(resp, url) { Object.defineProperty(resp, "url", { value: url }); return resp; }

beforeEach(() => {
  routes = []; calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hdrs = new Headers(input instanceof Request ? input.headers : init.headers || {});
    calls.push({ url, init, headers: hdrs, method: input instanceof Request ? input.method : init.method || "GET" });
    for (const [m, h] of routes) if (m.test(url)) return h(url, init, hdrs);
    return new Response("not mocked: " + url, { status: 599 });
  };
});

const post = (path, body, extra = {}) => new Request(ORIGIN + path, {
  method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.1.1.1", ...extra }, body: JSON.stringify(body),
});
const call = (req, env = ENV) => worker.fetch(req, env, CTX);

// ── fixtures ────────────────────────────────────────────────────────────────
const TIKTOK_HTML = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
  __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: {
    id: "123", desc: "Funny cat video",
    video: { cover: "https://p.tt/cover.jpg", duration: 15, bitrateInfo: [
      { CodecType: "h264", Bitrate: 900000, PlayAddr: { Height: 576, UrlList: ["https://v.tt/576.mp4"], DataSize: 2097152 } },
      { CodecType: "h264", Bitrate: 2000000, PlayAddr: { Height: 1080, UrlList: ["https://v.tt/1080.mp4"], DataSize: 10485760 } },
      { CodecType: "bytevc1", Bitrate: 1500000, PlayAddr: { Height: 1080, UrlList: ["https://v.tt/1080-hevc.mp4"] } },
    ] },
    music: { playUrl: "https://m.tt/a.mp3" },
  } } } },
})}</script></html>`;

const IG_EMBED = String.raw`<html><script>{"shortcode_media":{"video_url":"https:\/\/cdn.ig\/v\/clip.mp4?a=1\u0026b=2","display_url":"https:\/\/cdn.ig\/t.jpg","username":"someuser"}}</script></html>`;
const IG_EMBED_DOUBLE = String.raw`<script>"contextJSON":"{\"video_url\":\"https:\\/\\/cdn.ig\\/v\\/clip2.mp4?x=1\\u0026y=2\"}"</script>`;

const FB_HTML = String.raw`<html><head><meta property="og:title" content="My &amp; Reel"><meta property="og:image" content="https://fb.cdn/t.jpg"></head>
<script>{"browser_native_hd_url":"https:\/\/video.fb\/hd.mp4?oh=1\u0026oe=2","browser_native_sd_url":"https:\/\/video.fb\/sd.mp4?oh=1\u0026oe=2","playable_duration_in_ms":42000}</script></html>`;

// ── lib ─────────────────────────────────────────────────────────────────────
test("platformOf by hostname, not substring", () => {
  assert.equal(platformOf("https://vm.tiktok.com/abc"), "tiktok");
  assert.equal(platformOf("https://www.instagram.com/reel/x"), "instagram");
  assert.equal(platformOf("https://fb.watch/x"), "facebook");
  assert.equal(platformOf("https://www.1024terabox.com/s/1abc"), "terabox");
  assert.equal(platformOf("https://evil.com/?u=tiktok.com"), "other");
  assert.equal(platformOf("https://youtube.com/watch?v=1"), "other");
});

test("unescapeUrl handles single + double escaping", () => {
  assert.equal(unescapeUrl(String.raw`https:\/\/a.b\/c?x=1\u0026y=2`), "https://a.b/c?x=1&y=2");
  assert.equal(unescapeUrl(String.raw`https:\\/\\/a.b\\/c?x=1\\u0026y=2`), "https://a.b/c?x=1&y=2");
});

test("sign/verify roundtrip, tamper and expiry rejected", async () => {
  const path = await signProxy(ENV, { url: "https://cdn.test/v.mp4", filename: "a.mp4", headers: { Cookie: "a=b", Evil: "x" } });
  const p = new URL(ORIGIN + path).searchParams;
  const ok = await verifyProxy(ENV, p);
  assert.equal(ok.url, "https://cdn.test/v.mp4");
  assert.deepEqual(ok.headers, { Cookie: "a=b" }); // sirf whitelisted headers

  const renamed = new URLSearchParams(p); renamed.set("filename", "other.mp4"); // frontend rename karta hai
  assert.ok(await verifyProxy(ENV, renamed));

  const t1 = new URLSearchParams(p); t1.set("url", "https://evil.test/x.mp4");
  assert.equal(await verifyProxy(ENV, t1), null);
  const t2 = new URLSearchParams(p); t2.set("h", "e30");
  assert.equal(await verifyProxy(ENV, t2), null);
  const t3 = new URLSearchParams(p); t3.set("exp", "1");
  assert.equal(await verifyProxy(ENV, t3), null);
});

test("SSRF guard", () => {
  for (const u of ["http://127.0.0.1/x", "http://localhost/x", "http://10.0.0.5/x", "http://192.168.1.1/x",
    "http://169.254.169.254/latest", "http://[::1]/x", "ftp://a.com/x", "http://foo.local/x"]) assert.equal(isBlockedHost(u), true, u);
  assert.equal(isBlockedHost("https://v.tt/a.mp4"), false);
});

// ── TikTok ──────────────────────────────────────────────────────────────────
test("TikTok /info parses qualities, prefers h264, includes size", async () => {
  mock(/tiktok\.com\/@u\/video\/123/, () => new Response(TIKTOK_HTML, { headers: [["set-cookie", "ttwid=abc; Path=/"], ["set-cookie", "tt_chain=def; Path=/"]] }));
  const r = await call(post("/info", { url: "https://www.tiktok.com/@u/video/123" }));
  const d = await r.json();
  assert.equal(d.success, true);
  assert.deepEqual(d.video_formats.map((f) => f.id), [1080, 576]);
  assert.equal(d.video_formats[0].mb, 10);
  assert.match(d.title, /Funny cat video - VidSnap/);
  assert.equal(d.thumbnail, "https://p.tt/cover.jpg");
});

test("TikTok /download -> signed proxy -> streams with cookie + Range", async () => {
  mock(/tiktok\.com\/@u\/video\/123/, () => new Response(TIKTOK_HTML, { headers: [["set-cookie", "ttwid=abc; Path=/"]] }));
  mock(/v\.tt\/1080\.mp4/, (u, init) => new Response("VIDEOBYTES", {
    status: init.headers.Range ? 206 : 200,
    headers: { "Content-Type": "video/mp4", "Content-Length": "10", ...(init.headers.Range ? { "Content-Range": "bytes 0-9/100" } : {}) },
  }));
  const dl = await (await call(post("/download", { url: "https://www.tiktok.com/@u/video/123", quality: "1080", format: "video" }))).json();
  assert.equal(dl.success, true);
  assert.match(dl.url, /^\/proxy-download\?/);
  assert.equal(dl.preview_url, dl.url);

  // frontend filename rewrite
  const rewritten = dl.url.replace(/filename=[^&]*/, "filename=My%20Clip.mp4");
  const res = await call(new Request(ORIGIN + rewritten, { headers: { Range: "bytes=0-9", "CF-Connecting-IP": "2.2.2.2" } }));
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "VIDEOBYTES");
  assert.match(res.headers.get("content-disposition"), /My Clip\.mp4/);
  assert.equal(res.headers.get("content-range"), "bytes 0-9/100");
  const cdn = calls.find((c) => c.url.includes("v.tt/1080.mp4"));
  assert.match(cdn.init.headers.Cookie, /ttwid=abc/);
  assert.equal(cdn.init.headers.Range, "bytes=0-9");
});

test("TikTok audio uses music url as mp3", async () => {
  mock(/tiktok\.com\/@u\/video\/123/, () => new Response(TIKTOK_HTML));
  const dl = await (await call(post("/download", { url: "https://www.tiktok.com/@u/video/123", format: "audio" }))).json();
  const p = new URL(ORIGIN + dl.url).searchParams;
  assert.equal(p.get("url"), "https://m.tt/a.mp3");
  assert.match(p.get("filename"), /\.mp3$/);
});

test("TikTok falls back to tikwm when page has no data", async () => {
  mock(/tiktok\.com\//, () => new Response("<html>captcha</html>"));
  mock(/tikwm\.com\/api/, () => Response.json({ code: 0, data: { title: "From tikwm", hdplay: "https://tw/hd.mp4", play: "/video/sd.mp4", cover: "https://tw/c.jpg" } }));
  const d = await (await call(post("/info", { url: "https://www.tiktok.com/@u/video/9" }))).json();
  assert.equal(d.success, true);
  assert.deepEqual(d.video_formats.map((f) => f.label), ["HD", "SD"]);
});

// ── Instagram ───────────────────────────────────────────────────────────────
test("Instagram embed parse (plain + double-escaped)", async () => {
  mock(/instagram\.com\/p\/ABC123\/embed/, () => new Response(IG_EMBED));
  let d = await (await call(post("/download", { url: "https://www.instagram.com/reel/ABC123/", quality: "720" }))).json();
  assert.equal(new URL(ORIGIN + d.url).searchParams.get("url"), "https://cdn.ig/v/clip.mp4?a=1&b=2");

  routes = [];
  mock(/instagram\.com\/p\/ZZZ\/embed/, () => new Response(IG_EMBED_DOUBLE));
  d = await (await call(post("/download", { url: "https://www.instagram.com/p/ZZZ/" }))).json();
  assert.equal(new URL(ORIGIN + d.url).searchParams.get("url"), "https://cdn.ig/v/clip2.mp4?x=1&y=2");
});

test("Instagram graphql layer when embed fails", async () => {
  mock(/embed\/captioned/, () => new Response("nope", { status: 404 }));
  mock(/instagram\.com\/graphql\/query/, () => Response.json({ data: { xdt_shortcode_media: {
    is_video: true, video_url: "https://cdn.ig/g.mp4", display_url: "https://cdn.ig/g.jpg", video_duration: 9.5,
    dimensions: { height: 1280 }, owner: { username: "u" }, edge_media_to_caption: { edges: [{ node: { text: "Hello caption\nline2" } }] },
  } } }));
  const d = await (await call(post("/info", { url: "https://www.instagram.com/reel/GQL1/" }))).json();
  assert.equal(d.success, true);
  assert.match(d.title, /^Hello caption - VidSnap/);
});

test("Instagram og:video layer (no login) works when embed has no video", async () => {
  mock(/embed\/captioned/, () => new Response("<html>no video here</html>"));
  mock(/instagram\.com\/p\/OG1\/$/, (u, init) => new Response(
    init.headers["User-Agent"].includes("facebookexternalhit")
      ? `<meta property="og:video" content="https://cdn.ig/og.mp4?a=1&amp;b=2"><meta property="og:image" content="https://cdn.ig/og.jpg"><meta property="og:title" content="Cool reel">`
      : "<html></html>"));
  const dl = await (await call(post("/download", { url: "https://www.instagram.com/reel/OG1/" }))).json();
  assert.equal(new URL(ORIGIN + dl.url).searchParams.get("url"), "https://cdn.ig/og.mp4?a=1&b=2");
});

test("Instagram session layer uses IG_COOKIE and picks highest quality", async () => {
  mock(/embed\/captioned/, () => new Response("<html></html>"));
  mock(/instagram\.com\/p\/SES1/, () => new Response("<html></html>"));
  mock(/i\.instagram\.com\/api\/v1\/media\/\d+\/info/, (u, init) => {
    assert.equal(init.headers.Cookie, "sessionid=abc");
    return Response.json({ items: [{ caption: { text: "Cap line\nmore" }, video_duration: 12.4,
      video_versions: [{ url: "https://cdn.ig/s720.mp4", height: 720 }, { url: "https://cdn.ig/s1080.mp4", height: 1080 }],
      image_versions2: { candidates: [{ url: "https://cdn.ig/th.jpg" }] } }] });
  });
  const env = { ...ENV, IG_COOKIE: "sessionid=abc" };
  const d = await (await call(post("/info", { url: "https://www.instagram.com/reel/SES1/" }), env)).json();
  assert.deepEqual(d.video_formats.map((f) => f.id), [1080, 720]);
  assert.equal(d.duration, 12);
});

test("mediaIdOf converts shortcode like Instagram", async () => {
  const { mediaIdOf } = await import("../src/extractors/instagram.js");
  assert.equal(mediaIdOf("B"), "1"); // A=0, B=1
  assert.equal(mediaIdOf("BA"), "64");
});

// ── Facebook ────────────────────────────────────────────────────────────────
test("Facebook page parse HD+SD, decodes escapes", async () => {
  mock(/facebook\.com\/reel\/1/, () => new Response(FB_HTML));
  const d = await (await call(post("/info", { url: "https://www.facebook.com/reel/1" }))).json();
  assert.equal(d.success, true);
  assert.deepEqual(d.video_formats.map((f) => f.label), ["HD", "SD"]);
  assert.equal(d.duration, 42);
  assert.equal(d.title, "My & Reel - VidSnap");
  const dl = await (await call(post("/download", { url: "https://www.facebook.com/reel/1", quality: "720" }))).json();
  assert.equal(new URL(ORIGIN + dl.url).searchParams.get("url"), "https://video.fb/hd.mp4?oh=1&oe=2");
});

// ── Terabox ─────────────────────────────────────────────────────────────────
test("Terabox token + share/list flow, cookie goes into signed headers", async () => {
  const page = `<html>window.jsToken = fn%28%22TOK123%22%29; dp-logid=LOG9&x=1 "bdstoken":"BDS"</html>`;
  mock(/terabox\.com\/s\/1AbCd/, (u) => withUrl(new Response(page), "https://www.terabox.com/s/1AbCd"));
  mock(/\/share\/list\?/, (u) => {
    const p = new URL(u).searchParams;
    assert.equal(p.get("jsToken"), "TOK123");
    return Response.json(p.get("shorturl") === "AbCd"
      ? { errno: 0, list: [{ isdir: "1", server_filename: "folder" }, { isdir: "0", server_filename: "movie.mkv", size: "5242880", dlink: "https://d.terabox.com/file/abc", thumbs: { url3: "https://t/t.jpg" } }] }
      : { errno: 400141 });
  });
  const d = await (await call(post("/info", { url: "https://www.terabox.com/s/1AbCd" }))).json();
  assert.equal(d.success, true);
  assert.equal(d.video_formats[0].mb, 5);
  const dl = await (await call(post("/download", { url: "https://www.terabox.com/s/1AbCd" }))).json();
  const v = await verifyProxy(ENV, new URL(ORIGIN + dl.url).searchParams);
  assert.equal(v.url, "https://d.terabox.com/file/abc");
  assert.equal(v.headers.Cookie, "ndus=test");
  assert.equal(v.headers.Referer, "https://www.terabox.com/");
});

// ── debug ───────────────────────────────────────────────────────────────────
test("/debug reports per-layer results for instagram, rejects other platforms", async () => {
  mock(/embed\/captioned/, () => new Response("<html>Log in to continue accounts/login</html>"));
  mock(/graphql\/query/, () => Response.json({ status: "fail", message: "login_required" }));
  mock(/\/$/, () => Response.json({ status: "error", error: { code: "error.api.auth" } }));
  const r = await call(new Request(ORIGIN + "/debug?url=" + encodeURIComponent("https://www.instagram.com/reel/ABC123/")));
  const d = await r.json();
  assert.equal(d.platform, "instagram");
  assert.equal(d.embed.loginWall, true);
  assert.equal(d.embed.hasVideoUrl, false);
  assert.equal(d.graphql.apiMessage, "login_required");
  assert.ok(d.cobalt["api.cobalt.tools"]);
  const bad = await call(new Request(ORIGIN + "/debug?url=" + encodeURIComponent("https://example.com/x")));
  assert.equal(bad.status, 400);
});

// ── legacy forwarding / errors ──────────────────────────────────────────────
test("non-native platforms forward to legacy with real client IP", async () => {
  mock(/legacy\.test\/info/, (u, init, h) => Response.json({ success: true, title: "legacy yt", seen_ip: h.get("x-forwarded-for") }));
  const d = await (await call(post("/info", { url: "https://www.youtube.com/watch?v=abc" }))).json();
  assert.equal(d.title, "legacy yt");
  assert.equal(d.seen_ip, "1.1.1.1");
});

test("native failure falls back to legacy; without legacy -> clean error", async () => {
  mock(/tiktok\.com|tikwm|cobalt|co\.wuk\.sh/, () => new Response("blocked", { status: 403 }));
  mock(/legacy\.test\/download/, () => Response.json({ success: true, url: "/proxy-download?url=x&sig=legacy", title: "via yt-dlp" }));
  let d = await (await call(post("/download", { url: "https://www.tiktok.com/@u/video/5" }))).json();
  assert.equal(d.title, "via yt-dlp");

  const r = await call(post("/download", { url: "https://www.tiktok.com/@u/video/5" }), { ...ENV, LEGACY_BACKEND: "" });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).success, false);
});

test("old-style (non v=2) proxy links are forwarded to legacy", async () => {
  mock(/legacy\.test\/proxy-download/, () => new Response("LEGACYBYTES"));
  const r = await call(new Request(ORIGIN + "/proxy-download?url=https%3A%2F%2Fx.com%2Fa.mp4&sig=abc&exp=9999999999"));
  assert.equal(await r.text(), "LEGACYBYTES");
});

test("proxy rejects bad sig and SSRF targets even when signed", async () => {
  let r = await call(new Request(ORIGIN + "/proxy-download?v=2&url=https%3A%2F%2Fx.com%2Fa.mp4&sig=bad&exp=9999999999"));
  assert.equal(r.status, 403);
  const path = await signProxy(ENV, { url: "http://127.0.0.1:8080/secret", filename: "a.mp4", headers: {} });
  r = await call(new Request(ORIGIN + path));
  assert.equal(r.status, 403);
});

test("validation, rate limit, CORS, static fallthrough, ping", async () => {
  let r = await call(post("/info", { url: "not a url" }));
  assert.equal(r.status, 400);
  r = await call(new Request(ORIGIN + "/ping", { headers: { Origin: ORIGIN } }));
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  r = await call(new Request(ORIGIN + "/ping", { headers: { Origin: "https://evil.example" } }));
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  r = await call(new Request(ORIGIN + "/", { method: "GET" }));
  assert.equal(await r.text(), "static");

  mock(/tiktok\.com/, () => new Response("x", { status: 500 }));
  mock(/legacy\.test/, () => Response.json({ success: false, error: "x" }));
  let last;
  for (let i = 0; i < 30; i++) last = await call(post("/info", { url: "https://www.tiktok.com/@u/video/7" }, { "CF-Connecting-IP": "9.9.9.9" }));
  assert.equal(last.status, 429);
});

globalThis.fetch = realFetch;
