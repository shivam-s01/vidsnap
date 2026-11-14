import { fallbackResult } from "./fallbacks.js";

// X/Twitter, Pinterest: RapidAPI (GET by link) -> Cobalt. Fail ho to index.js legacy pe bhejta hai.
export const makeGeneric = (platform, defaultTitle) => (url, env, opts = {}) =>
  fallbackResult(env, platform, url, { ...opts, defaultTitle });
