import { fetchT, labelFor } from "../lib.js";
import { fallbackResult } from "./fallbacks.js";

export function videoIdOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com") {
    id = u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/) || [])[1];
  }
  return id && /^[\w-]{6,15}$/.test(id) ? id : null;
}

const LADDER = [1080, 720, 480, 360];

export async function extractYouTube(url, env, opts = {}) {
  const id = videoIdOf(url);
  if (!id) return null;
  const configured = Boolean(env.RAPIDAPI_KEY && (env.RAPID_YT_HOST || env.RAPID_HOST) && env.RAPID_YT_PATH);

  if (opts.quality === undefined && opts.isAudio === undefined) {
    if (!configured) return null;
    let title = "", thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    try {
      const r = await fetchT(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`, {}, 6000);
      if (r.ok) { const d = await r.json(); title = d.title || ""; thumb = d.thumbnail_url || thumb; }
    } catch {}
    return {
      title: title || "YouTube Video", thumbnail: thumb, duration: 0,
      formats: LADDER.map((h) => ({ id: h, label: labelFor(h), url: null })),
      audio: { url: null }, headers: {},
    };
  }
  if (!configured) return null;
  return fallbackResult(env, "youtube", `https://www.youtube.com/watch?v=${id}`, { ...opts, defaultTitle: "YouTube Video" });
}
