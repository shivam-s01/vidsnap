// Shared helpers — no platform logic here.

export const UA = {
  CHROME: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  MOBILE: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  FB: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  EDGE: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
};

export const MAX_URL_LEN = 2048;
export const PROXY_SIG_TTL = 3600; // seconds
export const NATIVE_PLATFORMS = new Set(["tiktok", "instagram", "facebook", "terabox", "youtube", "twitter", "pinterest"]);

const TB_TOKENS = ["terabox.com", "terabox.app", "teraboxapp.com", "1024terabox", "4funbox", "nephobox",
  "freeterabox.com", "mirrorbox.com", "terafileshare.com"];

export function platformOf(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "other"; }
  const is = (d) => host === d || host.endsWith("." + d);
  if (is("tiktok.com")) return "tiktok";
  if (is("instagram.com")) return "instagram";
  if (is("facebook.com") || is("fb.watch") || is("fb.com")) return "facebook";
  if (is("youtube.com") || is("youtu.be")) return "youtube";
  if (is("x.com") || is("twitter.com")) return "twitter";
  if (is("pinterest.com") || is("pin.it") || /^([a-z]{2}\.)?pinterest\.[a-z.]+$/.test(host)) return "pinterest";
  if (TB_TOKENS.some((t) => host.includes(t))) return "terabox";
  return "other";
}

export function validateUrl(url) {
  if (!url || url.length > MAX_URL_LEN) return "URL too long or empty.";
  if (!/^https?:\/\//i.test(url)) return "URL must start with https://";
  try {
    const p = new URL(url);
    if (!p.hostname.includes(".")) return "Invalid URL format.";
  } catch { return "Invalid URL."; }
  return "";
}

// ── responses ────────────────────────────────────────────────────────────────
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return {};
  let ok = false;
  try {
    const o = new URL(origin);
    const self = new URL(request.url);
    const extra = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    ok = o.origin === self.origin || o.hostname.endsWith(".railway.app") ||
      o.hostname.endsWith(".onrender.com") || extra.includes(o.origin) ||
      ["localhost", "127.0.0.1"].includes(o.hostname);
  } catch { /* bad origin */ }
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Adult-Token, X-Client, X-CF-Token, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition, Accept-Ranges",
    "Vary": "Origin",
  };
}

export function withHeaders(resp, headers) {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  r.headers.set("X-Content-Type-Options", "nosniff");
  return r;
}

// ── fetch with timeout ───────────────────────────────────────────────────────
export async function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { redirect: "follow", ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ── text decoding ────────────────────────────────────────────────────────────
// URL ke andar JSON-escaped sequences (\/ \u0026, double-escaped bhi) hatao.
export function unescapeUrl(s) {
  let out = s;
  for (let i = 0; i < 3; i++) {
    out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");
  }
  return out.replace(/\\/g, "");
}

export function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]) : "";
}

export function cookiesFrom(resp) {
  const list = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

// ── crypto / signing ─────────────────────────────────────────────────────────
const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function b64uEncode(str) {
  const bytes = enc.encode(str);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const SIGNED_HEADERS = ["Cookie", "Referer", "User-Agent", "Origin"];

export async function signProxy(env, { url, filename, headers }) {
  const exp = Math.floor(Date.now() / 1000) + PROXY_SIG_TTL;
  const clean = {};
  for (const k of SIGNED_HEADERS) if (headers && headers[k]) clean[k] = headers[k];
  const h = Object.keys(clean).length ? b64uEncode(JSON.stringify(clean)) : "";
  const sig = await hmacHex(env.PROXY_SECRET, `${url}|${h}|${exp}`); // filename sign nahi hota — frontend usse rename karta hai
  const q = new URLSearchParams({ url, filename, h, exp: String(exp), v: "2", sig });
  return `/proxy-download?${q.toString()}`;
}

export async function verifyProxy(env, params) {
  const url = params.get("url") || "", filename = params.get("filename") || "video.mp4";
  const h = params.get("h") || "", exp = params.get("exp") || "0", sig = params.get("sig") || "";
  if (!env.PROXY_SECRET || !sig || !/^\d+$/.test(exp) || Date.now() / 1000 > Number(exp)) return null;
  const expect = await hmacHex(env.PROXY_SECRET, `${url}|${h}|${exp}`);
  if (!safeEq(expect, sig)) return null;
  let headers = {};
  if (h) { try { headers = JSON.parse(b64uDecode(h)); } catch { return null; } }
  return { url, filename, headers };
}

// ── SSRF guard for proxy ─────────────────────────────────────────────────────
export function isBlockedHost(urlStr) {
  let u; try { u = new URL(urlStr); } catch { return true; }
  if (!/^https?:$/.test(u.protocol)) return true;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0") return true;
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6 literals
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
  }
  return false;
}

// ── per-isolate cache + rate limit (best effort) ─────────────────────────────
const _cache = new Map();
const CACHE_TTL = 300_000;
export function cacheGet(k) {
  const e = _cache.get(k);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  if (e) _cache.delete(k);
  return null;
}
export function cacheSet(k, data) {
  _cache.set(k, { data, ts: Date.now() });
  if (_cache.size > 300) for (const [key, v] of _cache) if (Date.now() - v.ts > CACHE_TTL) _cache.delete(key);
}

const _rate = new Map();
export const RATE_LIMITS = { "/info": [25, 60], "/download": [15, 60], "/proxy-download": [90, 60], default: [50, 60] };
export function rateOk(ip, path) {
  const [limit, win] = RATE_LIMITS[path] || RATE_LIMITS.default;
  const key = `${ip}:${path}`, now = Date.now();
  const bucket = (_rate.get(key) || []).filter((t) => now - t < win * 1000);
  if (bucket.length >= limit) { _rate.set(key, bucket); return false; }
  bucket.push(now); _rate.set(key, bucket);
  if (_rate.size > 2000) for (const [k, b] of _rate) if (!b.length || now - b[b.length - 1] > 120_000) _rate.delete(k);
  return true;
}

// ── format helpers ───────────────────────────────────────────────────────────
export function labelFor(h) {
  if (h >= 2160) return "4K Ultra HD (2160p)";
  if (h >= 1440) return "2K QHD (1440p)";
  if (h >= 1080) return "Full HD (1080p)";
  if (h >= 720) return "HD (720p)";
  return `${h}p`;
}

export function pickFormat(formats, quality) {
  const sorted = [...formats].sort((a, b) => b.id - a.id);
  return sorted.find((f) => f.id <= quality) || sorted[sorted.length - 1];
}

export function safeFilename(title, isAudio) {
  const safe = (title || "").replace(/[^\w\s-]/g, "").trim().slice(0, 50) || "video";
  return (safe + (isAudio ? ".mp3" : ".mp4")).replace(/\s+/g, "_");
}
