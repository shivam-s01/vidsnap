// /debug?url=... — har layer kya dekh raha hai, ye batata hai (koi secret/cookie output mein nahi aata).
import { UA, fetchT, platformOf } from "./lib.js";
import { _internals as ig } from "./extractors/instagram.js";
import { rapidProbe } from "./extractors/fallbacks.js";

const KEYS = ["video_url", "video_versions", "playable_url", "contextJSON", "__additionalDataLoaded", "gql_data", "shortcode_media", "xdt_", "is_video", "og:video", ".mp4", "dash_manifest"];
const markers = (t) => Object.fromEntries(KEYS.map((k) => [k, t.split(k).length - 1]).filter(([, n]) => n > 0));

const head = (t) => t.replace(/\s+/g, " ").slice(0, 160);

async function look(url, opts = {}) {
  const t = Date.now();
  try {
    const r = await fetchT(url, opts, 12000);
    const text = await r.text();
    return { status: r.status, finalUrl: r.url || url, bytes: text.length, ms: Date.now() - t, text };
  } catch (e) {
    return { error: String((e && e.message) || e), ms: Date.now() - t, text: "" };
  }
}
const strip = ({ text, ...rest }, checks = {}) => ({ ...rest, ...checks, head: head(text || "") });

async function cobalt(url) {
  const insts = ["https://api.cobalt.tools", "https://cobalt.api.timelessnesses.me", "https://cobalt-api.kwiatekmiki.com", "https://co.wuk.sh", "https://cobalt.catgirlsfor.science"];
  const out = {};
  await Promise.all(insts.map(async (i) => {
    const r = await look(`${i}/`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    let d = {}; try { d = JSON.parse(r.text); } catch { /* not json */ }
    out[i.replace("https://", "")] = { status: r.status, error: r.error, result: d.status, code: d.error && d.error.code };
  }));
  return out;
}

export async function debugProbe(url, env) {
  const plat = platformOf(url);
  const rep = { platform: plat, rapidapi_key_set: Boolean(env.RAPIDAPI_KEY) };
  const hdr = { "User-Agent": UA.CHROME, "Accept-Language": "en-US,en;q=0.9" };

  if (plat === "instagram") {
    const code = ig.shortcodeOf(url);
    rep.shortcode = code;
    if (code) {
      const e = await look(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers: hdr });
      const mp4 = e.text.indexOf(".mp4");
      rep.embed = strip(e, { hasVideoUrl: /video_url/.test(e.text), hasVideoTag: /<video/.test(e.text), loginWall: /accounts\/login|loginForm/i.test(e.text), markers: markers(e.text), mp4Snippet: mp4 > 0 ? e.text.slice(Math.max(0, mp4 - 140), mp4 + 20) : null });
      for (const [name, ua] of [["og_fb", UA.FB], ["og_twitter", "Twitterbot/1.0"]]) {
        const o = await look(`https://www.instagram.com/p/${code}/`, { headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" } });
        rep[name] = strip(o, { hasOgVideo: /og:video/.test(o.text), markers: markers(o.text) });
      }
      if (env.IG_COOKIE) {
        const m = await look(`https://i.instagram.com/api/v1/media/${ig.mediaIdOf(code)}/info/`, { headers: { "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 458229237)", "X-IG-App-ID": "567067343352427", Cookie: env.IG_COOKIE } });
        let mj = null; try { mj = JSON.parse(m.text); } catch { /* html */ }
        rep.session = strip(m, { json: Boolean(mj), hasItems: Boolean(mj && mj.items && mj.items.length), apiMessage: mj && mj.message, apiStatus: mj && mj.status });
      } else rep.session = "IG_COOKIE not set";
      const body = new URLSearchParams({ doc_id: env.IG_DOC_ID || "8845758582119845", variables: JSON.stringify({ shortcode: code }) });
      const g = await look("https://www.instagram.com/graphql/query", {
        method: "POST", body,
        headers: { ...hdr, "Content-Type": "application/x-www-form-urlencoded", "X-IG-App-ID": "936619743392459", Origin: "https://www.instagram.com", Referer: `https://www.instagram.com/p/${code}/` },
      });
      let j = null; try { j = JSON.parse(g.text); } catch { /* html */ }
      rep.graphql = strip(g, { json: Boolean(j), hasMedia: Boolean(j && j.data && j.data.xdt_shortcode_media), apiStatus: j && j.status, apiMessage: j && j.message });
    }
  } else if (plat === "facebook") {
    const p = await look(url, { headers: hdr });
    rep.page = strip(p, {
      hasHdKey: /browser_native_hd_url|playable_url_quality_hd|hd_src/.test(p.text),
      hasSdKey: /browser_native_sd_url|"playable_url"|sd_src/.test(p.text),
      loginWall: /login\/\?next|You must log in|id="login_form"/i.test(p.text),
    });
    const o = await look(url, { headers: { "User-Agent": UA.FB } });
    rep.og = strip(o, { hasOgVideo: /og:video/.test(o.text) });
  } else if (plat === "tiktok") {
    const p = await look(url, { headers: hdr });
    const m = p.text.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    let sc = null; try { sc = JSON.parse(m[1]).__DEFAULT_SCOPE__["webapp.video-detail"]; } catch { /* none */ }
    rep.page = strip(p, { hasRehydration: Boolean(m), detailStatus: sc && sc.statusCode, detailMsg: sc && sc.statusMsg, captcha: /captcha|verify/i.test(p.text.slice(0, 5000)) });
    const w = await look(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, { headers: { "User-Agent": UA.CHROME } });
    let wj = null; try { wj = JSON.parse(w.text); } catch { /* not json */ }
    rep.tikwm = strip(w, { code: wj && wj.code, msg: wj && wj.msg });
  }
  rep.rapid = await rapidProbe(env, plat, url);
  rep.cobalt = await cobalt(url);
  return rep;
}
