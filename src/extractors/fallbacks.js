import { fetchT } from "../lib.js";

const COBALT_INSTANCES = [
  "https://api.cobalt.tools",
  "https://cobalt.api.timelessnesses.me",
  "https://cobalt-api.kwiatekmiki.com",
  "https://co.wuk.sh",
  "https://cobalt.catgirlsfor.science",
];

const RAPID = {
  instagram: [
    { host: "instagram-reels-downloader-api.p.rapidapi.com", path: "/downloadReel",
      pick: (d) => (d.data || {}).video_url || (d.data || {}).download_url },
    { host: "instagram-downloader-download-instagram-videos-stories4.p.rapidapi.com", path: "/index",
      pick: (d) => { let m = d.media || d.data || d; if (Array.isArray(m)) m = m[0] || {}; return m.video || m.url || m.video_url; } },
  ],
  tiktok: [
    { host: "tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com", path: "/analysis", extra: { hd: "1" },
      pick: (d) => { const v = d.video || {}; return v.play || v.nwm_video_url || v.url; },
      title: (d) => d.title },
  ],
  facebook: [
    { host: "facebook-reel-and-video-downloader.p.rapidapi.com", path: "/app/main.php",
      pick: (d) => {
        for (const k of ["hd", "sd", "video_hd", "video_sd"]) {
          let v = d[k];
          if (Array.isArray(v) && v.length) v = typeof v[0] === "object" ? v[0].url : v[0];
          if (typeof v === "string" && v.startsWith("http")) return v;
        }
        return null;
      } },
  ],
};

const isUrl = (u) => typeof u === "string" && /^https?:\/\//.test(u) && u.length > 10;

export async function cobaltGet(url, quality = 720, isAudio = false) {
  const payload = {
    url, downloadMode: isAudio ? "audio" : "auto", filenameStyle: "basic",
    videoQuality: String(quality || 720), audioFormat: isAudio ? "mp3" : "best",
  };
  // Saare instances ek saath — pehla jo jawab de woh jeetega
  const attempts = COBALT_INSTANCES.map(async (inst) => {
    const r = await fetchT(`${inst}/`, {
      method: "POST", body: JSON.stringify(payload),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }, 10000);
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

export async function rapidGet(env, platform, url) {
  if (!env.RAPIDAPI_KEY) return null;
  for (const cfg of RAPID[platform] || []) {
    try {
      const q = new URLSearchParams({ url, ...(cfg.extra || {}) });
      const r = await fetchT(`https://${cfg.host}${cfg.path}?${q}`, {
        headers: { "x-rapidapi-key": env.RAPIDAPI_KEY, "x-rapidapi-host": cfg.host },
      }, 15000);
      if (!r.ok) continue;
      const d = await r.json();
      const u = cfg.pick(d);
      if (isUrl(u)) return { url: u, title: cfg.title ? cfg.title(d) : "" };
    } catch { /* next */ }
  }
  return null;
}

// Cobalt/RapidAPI ek hi link dete hain — usse standard result shape mein badlo
export async function fallbackResult(env, platform, url, { quality = 720, isAudio = false, defaultTitle = "Video" } = {}) {
  const rapid = isAudio ? null : await rapidGet(env, platform, url);
  const link = rapid ? rapid.url : await cobaltGet(url, quality, isAudio);
  if (!link) return null;
  const title = (rapid && rapid.title) || defaultTitle;
  const id = quality || 720;
  return {
    title, thumbnail: null, duration: 0,
    formats: isAudio ? [] : [{ id, label: "Best Available", url: link }],
    audio: isAudio ? { url: link } : null,
    headers: {},
  };
}
