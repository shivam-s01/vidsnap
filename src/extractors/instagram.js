import { UA, fetchT, unescapeUrl, labelFor, metaContent, decodeEntities } from "../lib.js";
import { rapidResult, cobaltResult } from "./fallbacks.js";

function shortcodeOf(url) {
  const m = new URL(url).pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) ||
    new URL(url).pathname.match(/^\/[^/]+\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function result({ videoUrl, thumb, title, duration, height }) {
  const h = height || 720;
  return {
    title: title || "Instagram Video", thumbnail: thumb || null, duration: duration || 0,
    formats: [{ id: h, label: labelFor(h), url: videoUrl }],
    audio: null,
    headers: { Referer: "https://www.instagram.com/", "User-Agent": UA.MOBILE },
  };
}

// Layer 1: /embed/captioned/ page — public reels/posts pe login nahi chahiye
async function viaEmbed(code) {
  const r = await fetchT(`https://www.instagram.com/p/${code}/embed/captioned/`, {
    headers: { "User-Agent": UA.CHROME, "Accept-Language": "en-US,en;q=0.9" },
  }, 15000);
  if (!r.ok) return null;
  const html = await r.text();
  // JSON kabhi seedha aata hai ("video_url":"..."), kabhi string ke andar escaped (\"video_url\":\"...\")
  const m = html.match(/"video_url":"([^"]+)"/) || html.match(/\\"video_url\\":\\"(.+?)\\"/);
  const src = m ? m[1] : (html.match(/<video[^>]+src="([^"]+)"/) || [])[1];
  if (!src) return null;
  const videoUrl = unescapeUrl(src.replace(/&amp;/g, "&"));
  if (!/^https?:/.test(videoUrl)) return null;
  const thumbM = html.match(/"display_url":"([^"]+)"/) || html.match(/\\"display_url\\":\\"(.+?)\\"/) ||
    html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
  const userM = html.match(/"username":"([^"]+)"/) || html.match(/\\"username\\":\\"(.+?)\\"/);
  return result({
    videoUrl,
    thumb: thumbM ? unescapeUrl(thumbM[1].replace(/&amp;/g, "&")) : null,
    title: userM ? `Instagram - ${userM[1]}` : "",
  });
}

// Layer 2: crawler UA ko Instagram og:video tags deta hai (login nahi chahiye)
async function viaOg(code) {
  for (const ua of [UA.FB, "Twitterbot/1.0"]) {
    const r = await fetchT(`https://www.instagram.com/p/${code}/`, {
      headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" },
    }, 12000);
    if (!r.ok) continue;
    const html = await r.text();
    const v = metaContent(html, "og:video:secure_url") || metaContent(html, "og:video:url") || metaContent(html, "og:video");
    if (!/^https?:/.test(v)) continue;
    return result({
      videoUrl: v, thumb: metaContent(html, "og:image") || null,
      title: decodeEntities(metaContent(html, "og:title")).replace(/\s+/g, " ").slice(0, 80),
    });
  }
  return null;
}

// Layer 3 (optional): IG_COOKIE secret (burner account ka sessionid) ke saath mobile API
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function mediaIdOf(code) {
  let id = 0n;
  for (const c of code.slice(0, 11)) id = id * 64n + BigInt(ALPHA.indexOf(c));
  return id.toString();
}

async function viaSession(code, env) {
  if (!env.IG_COOKIE) return null;
  const r = await fetchT(`https://i.instagram.com/api/v1/media/${mediaIdOf(code)}/info/`, {
    headers: {
      "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 458229237)",
      "X-IG-App-ID": "567067343352427", Cookie: env.IG_COOKIE, "Accept-Language": "en-US",
    },
  }, 15000);
  if (!r.ok) return null;
  const d = await r.json();
  const item = d && d.items && d.items[0];
  const node = item && (item.video_versions ? item : (item.carousel_media || []).find((m) => m.video_versions));
  if (!node) return null;
  const byH = new Map();
  for (const v of node.video_versions) if (v.url && !byH.has(v.height)) byH.set(v.height, v);
  const formats = [...byH.values()].sort((a, b) => b.height - a.height)
    .map((v) => ({ id: v.height, label: labelFor(v.height), url: v.url }));
  if (!formats.length) return null;
  const cand = node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates[0];
  const cap = (item.caption && item.caption.text) || "";
  return {
    title: cap.split("\n")[0].slice(0, 80) || (item.user ? `Instagram - ${item.user.username}` : "Instagram Video"),
    thumbnail: cand ? cand.url : null, duration: Math.round(node.video_duration || 0),
    formats, audio: null, headers: { "User-Agent": UA.MOBILE },
  };
}

// Layer 4: graphql doc_id (rotate hota rehta hai — IG_DOC_ID env se badal sakte ho)
async function viaGraphql(code, env) {
  const docId = env.IG_DOC_ID || "8845758582119845";
  const body = new URLSearchParams({
    doc_id: docId,
    variables: JSON.stringify({ shortcode: code, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null }),
  });
  const r = await fetchT("https://www.instagram.com/graphql/query", {
    method: "POST", body,
    headers: {
      "User-Agent": UA.CHROME, "Content-Type": "application/x-www-form-urlencoded",
      "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.instagram.com", Referer: `https://www.instagram.com/p/${code}/`,
    },
  }, 15000);
  if (!r.ok) return null;
  const d = await r.json();
  const media = d?.data?.xdt_shortcode_media;
  if (!media) return null;
  // carousel ho to pehla video node
  const node = media.is_video ? media
    : (media.edge_sidecar_to_children?.edges || []).map((e) => e.node).find((n) => n.is_video);
  if (!node?.video_url) return null;
  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  return result({
    videoUrl: node.video_url, thumb: node.display_url,
    title: cap.split("\n")[0].slice(0, 80) || (media.owner?.username ? `Instagram - ${media.owner.username}` : ""),
    duration: Number(node.video_duration) || 0, height: node.dimensions?.height,
  });
}

export async function extractInstagram(url, env, opts = {}) {
  const code = shortcodeOf(url);
  if (code) {
    // Cheap layers pehle, phir RapidAPI (sabse bharosemand), phir login-wali layers
    for (const layer of [() => viaEmbed(code), () => viaOg(code), () => rapidResult(env, "instagram", url, { ...opts, defaultTitle: "Instagram Video" }),
      () => viaSession(code, env), () => viaGraphql(code, env)]) {
      try { const r = await layer(); if (r) return r; } catch { /* next */ }
    }
  } else {
    const r = await rapidResult(env, "instagram", url, { ...opts, defaultTitle: "Instagram Video" });
    if (r) return r;
  }
  return cobaltResult(url, { ...opts, defaultTitle: "Instagram Video" });
}

export const _internals = { viaEmbed, viaOg, viaSession, viaGraphql, shortcodeOf, mediaIdOf };
