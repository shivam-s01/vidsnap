import { fetchT, labelFor } from "../lib.js";

const COBALT_INSTANCES = [
  "https://api.cobalt.tools",
  "https://cobalt.api.timelessnesses.me",
  "https://cobalt-api.kwiatekmiki.com",
  "https://co.wuk.sh",
  "https://cobalt.catgirlsfor.science",
];

const isUrl = (u) => typeof u === "string" && /^https?:\/\//.test(u) && u.length > 10;

const PAGE_HOSTS = new Set([
  "instagram.com", "www.instagram.com", "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
  "facebook.com", "www.facebook.com", "fb.watch", "x.com", "twitter.com", "www.tiktok.com", "vm.tiktok.com",
  "pinterest.com", "www.pinterest.com", "pin.it",
]);
const URL_KEYS = ["download_url", "downloadUrl", "video_url", "videoUrl", "url", "link", "src"];
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

function firstUrl(o) {
  if (!o || typeof o !== "object") return null;
  for (const k of URL_KEYS) {
    const u = o[k];
    if (!isUrl(u)) continue;
    try { if (PAGE_HOSTS.has(new URL(u).hostname.toLowerCase())) continue; } catch { continue; }
    return u;
  }
  return null;
}

function heightOf(o) {
  const w = num(o.width), h = num(o.height);
  if (w && h) return Math.min(w, h);
  if (h) return h;
  const s = String(o.quality || o.label || o.resolution || o.format_note || "");
  const m = s.match(/(\d{3,4})\s*p\b/i) || s.match(/^(\d{3,4})$/);
  return m ? Number(m[1]) : 0;
}

function kindOf(o) {
  const t = [o.type, o.mime, o.mimeType, o.mime_type, o.ext, o.extension, o.quality, o.label].filter(Boolean).join(" ").toLowerCase();
  if (/audio|mp3|m4a|opus|aac/.test(t)) return "audio";
  if (/image|photo|jpe?g|png|webp/.test(t)) return "image";
  return "video";
}

const GENERIC_TITLES = new Set(["", "instagram", "tiktok", "facebook", "youtube", "twitter", "x", "pinterest", "video"]);

export function parseRapid(d, { defaultTitle = "Video" } = {}) {
  if (!d || typeof d !== "object" || d.ok === false || d.success === false) return null;
  const root = d.data && typeof d.data === "object" && !Array.isArray(d.data) ? { ...d, ...d.data } : d;
  const cands = [];
  const add = (o) => {
    const url = firstUrl(o);
    if (url) cands.push({ url, kind: kindOf(o), height: heightOf(o), size: num(o.size_bytes || o.filesize || o.size) || null });
  };
  add(root);
  for (const k of ["medias", "media", "formats", "links", "items", "downloads", "videos"]) {
    if (!Array.isArray(root[k])) continue;
    for (const it of root[k]) {
      if (typeof it === "string") { if (isUrl(it)) cands.push({ url: it, kind: "video", height: 0, size: null }); }
      else add(it || {});
    }
  }
  if (isUrl(root.audio_url)) cands.push({ url: root.audio_url, kind: "audio", height: 0, size: null });

  const seen = new Set();
  const uniq = cands.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));
  const videos = uniq.filter((c) => c.kind === "video");
  const audios = uniq.filter((c) => c.kind === "audio");
  if (!videos.length && !audios.length) return null;

  const byH = new Map();
  for (const v of videos) if (!byH.has(v.height)) byH.set(v.height, v);
  let formats = [...byH.entries()].filter(([h]) => h).map(([h, v]) => ({
    id: h, label: labelFor(h), url: v.url, ...(v.size ? { size_bytes: v.size } : {}),
  })).sort((a, b) => b.id - a.id);
  if (!formats.length && videos.length) {
    formats = [{ id: 720, label: "Best Available", url: videos[0].url, ...(videos[0].size ? { size_bytes: videos[0].size } : {}) }];
  }

  let title = typeof root.title === "string" ? root.title.trim() : "";
  if (GENERIC_TITLES.has(title.toLowerCase())) {
    const cap = typeof root.caption === "string" ? root.caption.split("\n")[0].trim().slice(0, 80) : "";
    title = GENERIC_TITLES.has(cap.toLowerCase()) ? "" : cap;
  }
  const thumb = [root.thumbnail_url, root.thumbnail, root.cover, root.thumb].find(isUrl) || null;
  return {
    title: title || defaultTitle, thumbnail: thumb, duration: Math.round(num(root.duration)),
    formats, audio: audios.length ? { url: audios[0].url } : null, headers: {},
  };
}

const rapidHeaders = (env, host) => ({ "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": host, Accept: "application/json" });

async function rapidJson(env, platform, url, format) {
  if (!env.RAPIDAPI_KEY) return { skipped: "RAPIDAPI_KEY missing" };
  if (platform === "youtube") {
    const host = env.RAPID_YT_HOST || env.RAPID_HOST;
    if (!host || !env.RAPID_YT_PATH) return { skipped: "RAPID_HOST / RAPID_YT_PATH missing" };
    const r = await fetchT(`https://${host}${env.RAPID_YT_PATH}`, {
      method: "POST", headers: { ...rapidHeaders(env, host), "Content-Type": "application/json" },
      body: JSON.stringify({ url, format }),
    }, 30000);
    return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
  }
  if (!env.RAPID_HOST || !env.RAPID_PATH) return { skipped: "RAPID_HOST / RAPID_PATH missing" };
  const r = await fetchT(`https://${env.RAPID_HOST}${env.RAPID_PATH}?${new URLSearchParams({ url })}`, {
    headers: rapidHeaders(env, env.RAPID_HOST),
  }, 20000);
  return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
}

const _rc = new Map();
const RC_TTL = 120_000;

export async function rapidResult(env, platform, url, { quality = 720, isAudio = false, defaultTitle = "Video" } = {}) {
  try {
    if (platform === "youtube") {
      const tries = isAudio ? ["mp3"] : [`${quality}p`, quality > 720 ? "720p" : quality > 360 ? "360p" : null].filter(Boolean);
      for (const fmt of tries) {
        const key = `yt|${fmt}|${url}`;
        let res = _rc.get(key);
        if (!res || Date.now() - res.ts > RC_TTL) {
          const { json } = await rapidJson(env, platform, url, fmt);
          const p = parseRapid(json, { defaultTitle });
          if (!p) continue;
          res = { ts: Date.now(), p };
          _rc.set(key, res);
        }
        const p = res.p;
        if (isAudio) {
          const link = (p.audio && p.audio.url) || (p.formats[0] && p.formats[0].url);
          if (link) return { ...p, formats: [], audio: { url: link } };
        } else if (p.formats.length) return { ...p, audio: null };
      }
      return null;
    }
    if (isAudio) return null;
    const key = `g|${url}`;
    const hit = _rc.get(key);
    if (hit && Date.now() - hit.ts < RC_TTL) return hit.p;
    const { json } = await rapidJson(env, platform, url);
    const p = parseRapid(json, { defaultTitle });
    if (!p || !p.formats.length) return null;
    _rc.set(key, { ts: Date.now(), p });
    if (_rc.size > 200) for (const [k, v] of _rc) if (Date.now() - v.ts > RC_TTL) _rc.delete(k);
    return p;
  } catch { return null; }
}

export async function rapidProbe(env, platform, url) {
  const out = { key_set: Boolean(env.RAPIDAPI_KEY), host_set: Boolean(env.RAPID_HOST), path_set: Boolean(env.RAPID_PATH), yt_path_set: Boolean(env.RAPID_YT_PATH) };
  try {
    const r = await rapidJson(env, platform, url, "720p");
    if (r.skipped) return { ...out, skipped: r.skipped };
    const p = parseRapid(r.json);
    return {
      ...out, status: r.status, keys: r.json && typeof r.json === "object" ? Object.keys(r.json) : null,
      parsed: p ? { formats: p.formats.map((f) => f.id), audio: Boolean(p.audio), title: p.title } : null,
    };
  } catch (e) { return { ...out, error: String((e && e.message) || e) }; }
}

export async function cobaltGet(url, quality = 720, isAudio = false) {
  const payload = {
    url, downloadMode: isAudio ? "audio" : "auto", filenameStyle: "basic",
    videoQuality: String(quality || 720), audioFormat: isAudio ? "mp3" : "best",
  };

  const attempts = COBALT_INSTANCES.map(async (inst) => {
    const r = await fetchT(`${inst}/`, {
      method: "POST", body: JSON.stringify(payload),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }, 5000);
    if (!r.ok) throw new Error("cobalt " + r.status);
    const d = await r.json();
    if (["redirect", "stream", "tunnel", "picker"].includes(d.status)) {
      const u = d.url || (d.picker && d.picker[0] && d.picker[0].url);
      if (isUrl(u)) return u;
    }
    throw new Error("cobalt no url");
  });
  try { return await Promise.any(attempts); } catch { return null; }
}

export async function cobaltResult(url, { quality = 720, isAudio = false, defaultTitle = "Video" } = {}) {
  const link = await cobaltGet(url, quality, isAudio);
  if (!link) return null;
  return {
    title: defaultTitle, thumbnail: null, duration: 0,
    formats: isAudio ? [] : [{ id: quality || 720, label: "Best Available", url: link }],
    audio: isAudio ? { url: link } : null, headers: {},
  };
}

export async function fallbackResult(env, platform, url, { quality = 720, isAudio = false, defaultTitle = "Video" } = {}) {
  const rapid = await rapidResult(env, platform, url, { quality, isAudio, defaultTitle });
  if (rapid) return rapid;
  return cobaltResult(url, { quality, isAudio, defaultTitle });
}
