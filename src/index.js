import {
  UA, NATIVE_PLATFORMS, json, corsHeaders, withHeaders, platformOf, validateUrl, signProxy, verifyProxy,
  isBlockedHost, cacheGet, cacheSet, rateOk, pickFormat, safeFilename, fetchT,
} from "./lib.js";
import { extractTikTok } from "./extractors/tiktok.js";
import { extractInstagram } from "./extractors/instagram.js";
import { extractFacebook } from "./extractors/facebook.js";
import { extractTerabox } from "./extractors/terabox.js";
import { extractYouTube } from "./extractors/youtube.js";
import { makeGeneric } from "./extractors/generic.js";
import { debugProbe } from "./debug.js";

const EXTRACTORS = {
  tiktok: extractTikTok, instagram: extractInstagram, facebook: extractFacebook, terabox: extractTerabox,
  youtube: extractYouTube, twitter: makeGeneric("twitter", "X Video"), pinterest: makeGeneric("pinterest", "Pinterest Video"),
};
const PLATFORM_TITLE = {
  tiktok: "TikTok Video", instagram: "Instagram Video", facebook: "Facebook Video", terabox: "TeraBox Video",
  youtube: "YouTube Video", twitter: "X Video", pinterest: "Pinterest Video",
};
const LARGE_FILE_WARN_MB = 200;

// Jo endpoints abhi purane Flask backend pe hain
const LEGACY_PATHS = new Set(["/local-download", "/yt-batch-download", "/verify-captcha", "/adult-token"]);

const getIp = (request) => request.headers.get("CF-Connecting-IP") || "0.0.0.0";

// ── legacy forwarding ────────────────────────────────────────────────────────
async function forward(request, env) {
  if (!env.LEGACY_BACKEND) {
    return json({ success: false, error: "Could not fetch this video — it may be private, or the platform blocked the request." }, 502);
  }
  const u = new URL(request.url);
  const target = new URL(u.pathname + u.search, env.LEGACY_BACKEND);
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-For", getIp(request));
  headers.delete("Origin"); // server-to-server call
  return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual", duplex: "half" }));
}

// ── /info ────────────────────────────────────────────────────────────────────
function sizeInfo(f) {
  if (!f.size_bytes) return { size: "Auto", mb: null };
  const mb = Math.round((f.size_bytes / 1048576) * 10) / 10;
  return { size: mb >= 1 ? `${mb} MB` : `${Math.round(mb * 1024)} KB`, mb };
}

async function handleInfo(request, env) {
  const body = await request.clone().json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const err = validateUrl(url);
  if (err) return json({ success: false, error: err }, 400);

  const plat = platformOf(url);
  if (!NATIVE_PLATFORMS.has(plat)) return forward(request, env);
  if (!rateOk(getIp(request), "/info")) return json({ success: false, error: "Too many requests" }, 429);

  const ck = "info|" + url;
  const cached = cacheGet(ck);
  if (cached) return json(cached);

  let res = null;
  try { res = await EXTRACTORS[plat](url, env, {}); } catch { /* fall through to legacy */ }
  if (!res || (!res.formats.length && !res.audio)) return forward(request, env);

  const video_formats = [...res.formats].sort((a, b) => b.id - a.id).map((f) => {
    const { size, mb } = sizeInfo(f);
    return { id: f.id, label: f.label, size, mb, large_file: mb !== null && mb > LARGE_FILE_WARN_MB, url: "worker" };
  });
  const audio_formats = res.audio ? [{ id: 128, label: "🎵 Audio (Best Available)", size: "Auto", url: "worker" }] : [];
  const data = {
    success: true, title: `${res.title || PLATFORM_TITLE[plat]} - VidSnap`, thumbnail: res.thumbnail || null,
    duration: res.duration || 0, video_formats,
    // Native audio nahi mila to bhi option dikhao — /download legacy (ffmpeg) pe jayega
    audio_formats: audio_formats.length ? audio_formats : [{ id: 128, label: "🎵 Audio (MP3)", size: "Auto", url: "worker" }],
  };
  cacheSet(ck, data);
  return json(data);
}

// ── /download ────────────────────────────────────────────────────────────────
function notifyOneSignal(env, title) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) return Promise.resolve();
  return fetchT("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: { Authorization: `Basic ${env.ONESIGNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.ONESIGNAL_APP_ID, included_segments: ["All"],
      headings: { en: "✅ Download Ready!" }, contents: { en: `${title} is ready to download.` },
    }),
  }, 5000).catch(() => {});
}

async function handleDownload(request, env, ctx) {
  const body = await request.clone().json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const q = String(body.quality ?? "720");
  const quality = /^\d+$/.test(q) ? Number(q) : 720;
  const isAudio = String(body.format || "video").toLowerCase() === "audio";
  const err = validateUrl(url);
  if (err) return json({ success: false, error: err }, 400);

  const plat = platformOf(url);
  if (!NATIVE_PLATFORMS.has(plat)) return forward(request, env);
  if (!rateOk(getIp(request), "/download")) return json({ success: false, error: "Too many requests" }, 429);
  if (!env.PROXY_SECRET) return json({ success: false, error: "Server misconfigured (PROXY_SECRET missing)" }, 500);

  let res = null;
  try { res = await EXTRACTORS[plat](url, env, { quality, isAudio }); } catch { /* legacy */ }

  let link = null, headers = res ? res.headers : {};
  if (res) {
    if (isAudio) link = res.audio ? res.audio.url : null;
    else if (res.formats.length) link = pickFormat(res.formats, quality).url;
  }
  // Native se nahi bana (jaise IG/FB/Terabox ka audio) -> purana backend (yt-dlp + ffmpeg)
  if (!link) return forward(request, env);

  const title = res.title || PLATFORM_TITLE[plat];
  const filename = safeFilename(title, isAudio);
  const proxy = await signProxy(env, { url: link, filename, headers });
  const fmt = !isAudio && res.formats.find((f) => f.url === link);
  const mb = fmt && fmt.size_bytes ? Math.round((fmt.size_bytes / 1048576) * 10) / 10 : null;

  ctx.waitUntil(notifyOneSignal(env, title));
  return json({
    success: true, url: proxy, title: `${title} - VidSnap`, file_size_mb: mb,
    large_file: (mb || 0) > LARGE_FILE_WARN_MB, preview_url: isAudio ? null : proxy,
  });
}

// ── /proxy-download (streaming) ──────────────────────────────────────────────
function defaultHeaders(remote) {
  const host = new URL(remote).hostname;
  if (/terabox|4funbox|nephobox|1024tera|baidupcs|baiduyun/.test(host)) {
    return { "User-Agent": UA.EDGE, Referer: "https://www.terabox.com/", Origin: "https://www.terabox.com" };
  }
  return { "User-Agent": UA.CHROME, Referer: "https://www.google.com/" };
}

async function handleProxy(request, env) {
  const params = new URL(request.url).searchParams;
  if (params.get("v") !== "2") return forward(request, env); // purane backend ke signed links

  const v = await verifyProxy(env, params);
  if (!v) return json({ error: "Unauthorized / Link expired" }, 403);
  if (isBlockedHost(v.url)) return json({ error: "Blocked" }, 403);
  if (!rateOk(getIp(request), "/proxy-download")) return json({ error: "Too many requests" }, 429);

  const hdrs = { Accept: "*/*", ...defaultHeaders(v.url), ...v.headers };
  Object.keys(hdrs).forEach((k) => { if (!hdrs[k]) delete hdrs[k]; });
  const range = request.headers.get("Range");
  if (range) hdrs.Range = range;

  let r;
  try { r = await fetchT(v.url, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: hdrs }, 30000); }
  catch { return json({ error: "Proxy error" }, 502); }
  if ([401, 403, 404, 410].includes(r.status)) {
    // Kuch CDN links client-IP se bandhe hote hain (worker ko deny, user ko allow): browser download ho to seedha bhej do
    if (request.headers.get("Sec-Fetch-Mode") === "navigate") return Response.redirect(v.url, 302);
    return json({ error: `Source denied access (${r.status})` }, 502);
  }

  const name = v.filename.replace(/[^\w.\- ]/g, "_");
  let ct = r.headers.get("Content-Type") || "video/mp4";
  if (name.endsWith(".mp3")) ct = "audio/mpeg";
  else if (name.endsWith(".mp4")) ct = "video/mp4";
  else if (name.endsWith(".webm")) ct = "video/webm";

  const out = new Headers({
    "Content-Type": ct,
    "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(v.filename)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  for (const h of ["Content-Length", "Content-Range"]) { const val = r.headers.get(h); if (val) out.set(h, val); }
  return new Response(request.method === "HEAD" ? null : r.body, { status: r.status, headers: out });
}

// ── /debug ───────────────────────────────────────────────────────────────────
async function handleDebug(request, env) {
  const url = (new URL(request.url).searchParams.get("url") || "").trim();
  const err = validateUrl(url);
  if (err) return json({ error: err }, 400);
  if (!NATIVE_PLATFORMS.has(platformOf(url))) return json({ error: "Only TikTok / Instagram / Facebook / TeraBox / YouTube / X / Pinterest links" }, 400);
  if (!rateOk(getIp(request), "/debug")) return json({ error: "Too many requests" }, 429);
  return json(await debugProbe(url, env));
}

// ── entry ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const { pathname: path } = new URL(request.url);
    const cors = corsHeaders(request, env);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

      let resp;
      if (path === "/ping") resp = json({ status: "ok", ts: Date.now(), configured: Boolean(env.PROXY_SECRET), terabox_cookie: Boolean(env.TERABOX_COOKIE), rapidapi: Boolean(env.RAPIDAPI_KEY), rapid_host: Boolean(env.RAPID_HOST), rapid_path: Boolean(env.RAPID_PATH), rapid_yt_path: Boolean(env.RAPID_YT_PATH) });
      else if (path === "/info" && request.method === "POST") resp = await handleInfo(request, env);
      else if (path === "/download" && request.method === "POST") resp = await handleDownload(request, env, ctx);
      else if (path === "/proxy-download" && ["GET", "HEAD"].includes(request.method)) resp = await handleProxy(request, env);
      else if (path === "/debug" && request.method === "GET") resp = await handleDebug(request, env);
      else if (LEGACY_PATHS.has(path)) resp = await forward(request, env);
      else return env.ASSETS.fetch(request); // index.html, adult.html, static files

      return withHeaders(resp, cors);
    } catch (e) {
      return withHeaders(json({ success: false, error: "Server error — please retry" }, 500), cors);
    }
  },
};
