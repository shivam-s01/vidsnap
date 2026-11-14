import { UA, fetchT } from "../lib.js";

const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|webm|flv|ts|m4v)$/i;

function between(text, start, end) {
  const s = text.indexOf(start);
  if (s === -1) return "";
  const from = s + start.length;
  const e = text.indexOf(end, from);
  return e === -1 ? "" : text.slice(from, e);
}

function baseHeaders(cookie) {
  const h = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
    "User-Agent": UA.EDGE,
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

// Step 1+2: share page se surl, jsToken, logid, bdstoken nikalo
async function getTokens(url, cookie) {
  const r = await fetchT(url, { headers: { ...baseHeaders(cookie), Accept: "text/html,*/*" } }, 15000);
  if (!r.ok) return null;
  const finalUrl = r.url || url;
  const u = new URL(finalUrl);
  const html = await r.text();

  // ?surl=XXXX seedha; /s/1XXXX mein leading "1" API ke liye hata dete hain.
  // Dono variants try honge (share/list loop mein).
  const candidates = [];
  const q = u.searchParams.get("surl");
  if (q) candidates.push(q);
  const m = u.pathname.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) { if (m[1].startsWith("1")) candidates.push(m[1].slice(1)); candidates.push(m[1]); }
  const surls = [...new Set(candidates)];
  if (!surls.length) return null;

  const jsToken = between(html, "fn%28%22", "%22%29");
  const logid = between(html, "dp-logid=", "&");
  const bdstoken = between(html, 'bdstoken":"', '"');
  if (!jsToken || !logid) return null;
  return { surls, jsToken, logid, bdstoken, finalUrl, host: u.host, cookie };
}

// Step 3: share/list API
async function shareList(t) {
  const bases = [...new Set([`https://${t.host}`, "https://www.1024terabox.com", "https://www.terabox.com", "https://www.terabox.app"])];
  for (const surl of t.surls) {
    const params = new URLSearchParams({
      app_id: "250528", web: "1", channel: "dubox", clienttype: "0",
      jsToken: t.jsToken, "dp-logid": t.logid, page: "1", num: "20", by: "name", order: "asc",
      site_referer: t.finalUrl, shorturl: surl, root: "1",
    });
    for (const base of bases) {
      try {
        const r = await fetchT(`${base}/share/list?${params}`, { headers: baseHeaders(t.cookie) }, 15000);
        const d = await r.json();
        if (d.errno === 0 && Array.isArray(d.list) && d.list.length) return d.list;
      } catch { /* next base */ }
    }
  }
  return [];
}

export async function extractTerabox(url, env) {
  const cookie = env.TERABOX_COOKIE || "";
  const tokens = await getTokens(url, cookie);
  if (!tokens) return null;
  const files = (await shareList(tokens)).filter((f) => !Number(f.isdir));
  if (!files.length) return null;
  const chosen = files.find((f) => VIDEO_EXTS.test(f.server_filename || "")) || files[0];
  const dlink = chosen.dlink;
  if (!dlink || !/^https?:/.test(dlink)) return null;

  const name = chosen.server_filename || "video.mp4";
  return {
    title: name.replace(/\.\w{2,4}$/, "") || "TeraBox Video",
    thumbnail: chosen.thumbs?.url3 || chosen.thumbs?.url2 || null,
    duration: 0,
    formats: [{ id: 1080, label: "Original Quality", url: dlink, size_bytes: Number(chosen.size) || null }],
    audio: null,
    // proxy yeh headers khud lagayega — alag se third-party proxy ki zaroorat nahi
    headers: { Cookie: cookie, Referer: "https://www.terabox.com/", Origin: "https://www.terabox.com", "User-Agent": UA.EDGE },
  };
}

export const _internals = { getTokens, shareList };
