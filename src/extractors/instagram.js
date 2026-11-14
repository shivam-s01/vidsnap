import { UA, fetchT, unescapeUrl, labelFor } from "../lib.js";
import { fallbackResult } from "./fallbacks.js";

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

// Layer 2: graphql doc_id (rotate hota rehta hai — IG_DOC_ID env se badal sakte ho)
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
    for (const layer of [() => viaEmbed(code), () => viaGraphql(code, env)]) {
      try { const r = await layer(); if (r) return r; } catch { /* next */ }
    }
  }
  return fallbackResult(env, "instagram", url, { ...opts, defaultTitle: "Instagram Video" });
}

export const _internals = { viaEmbed, viaGraphql, shortcodeOf };
