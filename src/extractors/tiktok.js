import { UA, fetchT, cookiesFrom, labelFor } from "../lib.js";
import { fallbackResult } from "./fallbacks.js";

async function viaPage(url) {
  const r = await fetchT(url, {
    headers: { "User-Agent": UA.CHROME, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,*/*;q=0.8" },
  }, 15000);
  if (!r.ok) return null;
  const cookie = cookiesFrom(r);
  const html = await r.text();
  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const detail = data?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  if (!detail || (detail.statusCode && detail.statusCode !== 0)) return null;
  const item = detail.itemInfo?.itemStruct;
  const video = item?.video;
  if (!video) return null;

  const infos = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
  const h264 = infos.filter((b) => !/bytevc1|h265|hevc/i.test(b.CodecType || ""));
  const pool = h264.length ? h264 : infos;
  const byHeight = new Map();
  for (const b of pool) {
    const pa = b.PlayAddr || {};
    const u = (pa.UrlList || []).find((x) => /^https?:/.test(x));
    const h = Number(pa.Height) || Number(b.GearName?.match(/(\d{3,4})p/)?.[1]) || 0;
    if (!u || !h) continue;
    const prev = byHeight.get(h);
    if (!prev || (b.Bitrate || 0) > prev.bitrate) {
      byHeight.set(h, { id: h, label: labelFor(h), url: u, bitrate: b.Bitrate || 0, size_bytes: Number(pa.DataSize) || null });
    }
  }
  let formats = [...byHeight.values()].map(({ bitrate, ...f }) => f);
  if (!formats.length) {
    const u = video.playAddr || video.downloadAddr;
    if (typeof u === "string" && /^https?:/.test(u)) {
      const h = Number(video.height) || 720;
      formats = [{ id: h, label: labelFor(h), url: u }];
    }
  }
  if (!formats.length) return null;

  return {
    title: (item.desc || "").trim() || `TikTok ${item.id || ""}`.trim(),
    thumbnail: video.cover || video.originCover || null,
    duration: Number(video.duration) || 0,
    formats,
    audio: item.music?.playUrl ? { url: item.music.playUrl } : null,
    headers: { Cookie: cookie, Referer: "https://www.tiktok.com/", "User-Agent": UA.CHROME },
  };
}

async function viaTikwm(url) {
  const r = await fetchT(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
    headers: { "User-Agent": UA.CHROME },
  }, 15000);
  if (!r.ok) return null;
  const d = await r.json();
  if (d.code !== 0 || !d.data) return null;
  const abs = (u) => (!u ? null : u.startsWith("/") ? "https://www.tikwm.com" + u : u);
  const formats = [];
  const hd = abs(d.data.hdplay), sd = abs(d.data.play);
  if (hd) formats.push({ id: 720, label: "HD", url: hd });
  if (sd && sd !== hd) formats.push({ id: 480, label: "SD", url: sd });
  if (!formats.length) return null;
  return {
    title: (d.data.title || "").trim() || "TikTok Video",
    thumbnail: abs(d.data.cover), duration: Number(d.data.duration) || 0,
    formats, audio: d.data.music ? { url: abs(d.data.music) } : null,
    headers: {},
  };
}

export async function extractTikTok(url, env, opts = {}) {
  for (const layer of [() => viaPage(url), () => viaTikwm(url)]) {
    try { const r = await layer(); if (r) return r; } catch {}
  }
  return fallbackResult(env, "tiktok", url, { ...opts, defaultTitle: "TikTok Video" });
}

export const _internals = { viaPage, viaTikwm };
