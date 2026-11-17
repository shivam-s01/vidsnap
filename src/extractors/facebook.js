import { UA, fetchT, decodeEntities, metaContent, unescapeUrl } from "../lib.js";
import { fallbackResult } from "./fallbacks.js";

function jsonStr(s) {
  try { return JSON.parse(`"${s}"`); } catch { return unescapeUrl(s); }
}

const HD_RE = /"(?:browser_native_hd_url|playable_url_quality_hd|hd_src_no_ratelimit|hd_src)":\s*"([^"]+)"/;
const SD_RE = /"(?:browser_native_sd_url|playable_url|sd_src_no_ratelimit|sd_src)":\s*"([^"]+)"/;

async function getPage(url, ua) {
  const r = await fetchT(url, {
    headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  }, 15000);
  if (!r.ok) return null;
  return r.text();
}

function build(html, { hd, sd }) {
  const formats = [];
  if (hd) formats.push({ id: 720, label: "HD", url: hd });
  if (sd && sd !== hd) formats.push({ id: 360, label: "SD", url: sd });
  if (!formats.length) return null;
  const dur = html.match(/"playable_duration_in_ms":\s*(\d+)/);
  const title = metaContent(html, "og:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/) || [])[1] || "";
  return {
    title: decodeEntities(title).trim() || "Facebook Video",
    thumbnail: metaContent(html, "og:image") || null,
    duration: dur ? Math.round(Number(dur[1]) / 1000) : 0,
    formats, audio: null,
    headers: { Referer: "https://www.facebook.com/", "User-Agent": UA.CHROME },
  };
}

async function viaPage(url) {
  const html = await getPage(url, UA.CHROME);
  if (!html) return null;
  const hd = (html.match(HD_RE) || [])[1], sd = (html.match(SD_RE) || [])[1];
  return build(html, { hd: hd && jsonStr(hd), sd: sd && jsonStr(sd) });
}

async function viaOg(url) {
  const html = await getPage(url, UA.FB);
  if (!html) return null;
  const og = metaContent(html, "og:video:secure_url") || metaContent(html, "og:video:url") || metaContent(html, "og:video");
  if (!/^https?:/.test(og || "")) return null;
  return build(html, { sd: og });
}

export async function extractFacebook(url, env, opts = {}) {
  for (const layer of [() => viaPage(url), () => viaOg(url)]) {
    try { const r = await layer(); if (r) return r; } catch {}
  }
  return fallbackResult(env, "facebook", url, { ...opts, defaultTitle: "Facebook Video" });
}

export const _internals = { viaPage, viaOg };
