# VidSnap

A video downloader that runs entirely on a Cloudflare Worker. The Worker serves the frontend and handles the API, so there is nothing else to host for the supported platforms.

Native extractors: TikTok, Instagram, Facebook and TeraBox. YouTube, X and Pinterest go through RapidAPI. Anything the Worker can't handle (other sites, audio conversion, failed extractions) is forwarded to the old Flask backend set in `LEGACY_BACKEND`.

## Setup

```bash
npm install
npm run dev      # local dev server
npm test         # offline tests
npm run deploy   # deploy with wrangler
```

If the repo is connected to Cloudflare, every push to `main` deploys automatically.

## Configuration

Secrets (Worker settings, or `wrangler secret put <NAME>`):

| Name | Required | What it is |
| --- | --- | --- |
| `PROXY_SECRET` | yes | Random string, 32+ characters. Used to sign download links. |
| `TERABOX_COOKIE` | recommended | Your TeraBox cookie, like `ndus=...`. |
| `RAPIDAPI_KEY` | for YouTube, X, Pinterest | RapidAPI key. Also used as a fallback for the other platforms. |
| `IG_COOKIE` | no | Instagram session cookie, enables one extra extraction layer. |
| `IG_DOC_ID` | no | Overrides the Instagram GraphQL doc id when it rotates. |
| `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY` | no | Push notification when a download is ready. |

Variables in `wrangler.toml`:

| Name | What it is |
| --- | --- |
| `LEGACY_BACKEND` | URL of the old Flask backend. Remove it once everything runs natively. |
| `ALLOWED_ORIGINS` | Extra origins allowed to call the API, comma separated. |
| `RAPID_HOST` | RapidAPI host, taken from the code snippet tab of the API. |
| `RAPID_PATH` | GET endpoint, called as `?url=<link>`. |
| `RAPID_YT_PATH` | POST endpoint for YouTube, body is `{ url, format }`. |
| `RAPID_YT_HOST` | Only needed if the YouTube API uses a different host. |

The free RapidAPI plan allows 1000 requests a month. `/info` and `/download` share one credit because results are cached for two minutes, and YouTube `/info` doesn't use a credit at all.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /info` | Title, thumbnail and available qualities for a link |
| `POST /download` | Returns a signed link for the chosen quality |
| `GET /proxy-download` | Streams the file through the Worker, supports Range requests |
| `GET /debug?url=<link>` | Shows what each extraction layer returned and why it failed |
| `GET /ping` | Health check and a quick view of which settings are present |

`/debug` never prints secrets or cookies.

## Project layout

```
src/index.js          router and request handlers
src/lib.js            helpers: signing, CORS, caching, rate limiting
src/debug.js          debug probe
src/extractors/       one file per platform, plus fallbacks.js (RapidAPI, Cobalt)
public/               index.html and adult.html
test/                 offline tests with a mocked fetch
```

`public/adult.html` is a separate age-gated page that uses the same API. It opens with a date of birth and arithmetic check before showing the downloader.

## Things to know

- The scrapers depend on each site's internal HTML and JSON, so they break when a site changes. Run `wrangler tail` first when something stops working, then check `/debug`.
- Caching and rate limiting live in memory per isolate, so they are best effort. For a hard limit, add a rate limiting rule in the Cloudflare dashboard.
- The tests use a mocked `fetch`. They check parsing, signing and proxy behaviour, not whether the real sites are up.
