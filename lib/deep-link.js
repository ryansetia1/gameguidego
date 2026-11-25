/**
 * Opt-in deep link (#67): /?game=..&platform=..&igdb=..&q=..&rlog_item=..&step=..
 * Everything is validated at this boundary; anything invalid is dropped, and a
 * link without a usable `game` returns null (app behaves as if there were no link).
 */
import { platformLabelFor } from "./platforms.js";
import { IGDB_ID_OFFSET } from "./games.js";

const TEXT_RE = /[\u0000-\u001f\u007f<>]/g;

/** Strip control chars and angle brackets (no HTML), collapse spaces, cap length.
 * @param {unknown} value @param {number} max */
function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(TEXT_RE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Short opaque token: letters, digits, `_-.:` only. @param {unknown} value */
function token(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return /^[\w.:-]{1,64}$/.test(v) ? v : "";
}

/**
 * @param {string | URLSearchParams} search
 * @returns {{ game: string; platform: string; catalogGameId: number | null; q: string; rlogItem: string; step: string } | null}
 */
export function parseDeepLink(search) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const game = clean(params.get("game") ?? "", 120);
  if (!game) return null;
  const rawPlatform = clean(params.get("platform") ?? "", 60);
  // Only our known labels, so a free-text value can't create junk rooms.
  const platform = platformLabelFor(rawPlatform);
  const igdbRaw = (params.get("igdb") ?? "").trim();
  const igdb = /^\d{1,9}$/.test(igdbRaw) && Number(igdbRaw) > 0 ? Number(igdbRaw) : null;
  return {
    game,
    platform,
    catalogGameId: igdb == null ? null : IGDB_ID_OFFSET + igdb,
    q: clean(params.get("q") ?? "", 2000),
    rlogItem: token(params.get("rlog_item")),
    step: token(params.get("step")),
  };
}

const DEEP_LINK_KEYS = ["game", "platform", "igdb", "q", "rlog_item", "step"];

/** URL (path + remaining query) with the deep-link params removed. @param {string} href */
export function stripDeepLinkParams(href) {
  const url = new URL(href);
  for (const k of DEEP_LINK_KEYS) url.searchParams.delete(k);
  return `${url.pathname}${url.search}${url.hash}`;
}
