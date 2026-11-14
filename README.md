# VidSnap on Cloudflare Workers

Frontend + TikTok / Instagram / Facebook / TeraBox extractors ek hi Worker mein.
YouTube, generic sites, audio-extract aur jab native extractor fail ho, woh purane Flask backend
(`LEGACY_BACKEND` in wrangler.toml) pe forward hota hai. YouTube ko JS mein shift karne ke baad us var ko hata do.

## Deploy (GitHub Actions)
Repo Settings > Secrets mein daalo:
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `PROXY_SECRET`: koi bhi 32+ random chars (required)
- `TERABOX_COOKIE`: `ndus=...` (apna fresh cookie)
- `RAPIDAPI_KEY`: optional fallback

`main` pe push karte hi tests + deploy chalega.

## Layout
- `src/index.js` router: /info, /download, /proxy-download (streaming), legacy forward
- `src/extractors/*` har platform ka scraper + `fallbacks.js` (cobalt, RapidAPI)
- `public/` index.html, adult.html (same-origin Worker use karte hain)
- `test/` offline tests (mock fetch): `npm test`

## Dhyan rakho
- Scrapers sites ke internal HTML/JSON pe tike hain; format badalne pe tootenge. Pehle `wrangler tail` se logs dekho.
- Rate-limit/cache per-isolate best effort hai. Pakka limit chahiye to Cloudflare WAF rate-limit rule lagao.
