import { fallbackResult } from "./fallbacks.js";

export const makeGeneric = (platform, defaultTitle) => (url, env, opts = {}) =>
  fallbackResult(env, platform, url, { ...opts, defaultTitle });
