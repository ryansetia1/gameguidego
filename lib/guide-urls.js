/** @typedef {{ preferred_guide_url?: string; preferred_guide_urls?: unknown }} GuideUrlRow */

import {
  canonicalGamefaqsBundleUrl,
  parseGamefaqsFaqUrl,
  sameGamefaqsBundle,
} from "./gamefaqs-bundle.js";

export const MAX_GUIDE_URLS = 5;

/**
 * Accept only well-formed http(s) guide URLs.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanGuideUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 300);
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Normalize a preferred guide entry (canonical GameFAQs bundle root when applicable).
 * @param {string} raw
 * @returns {string}
 */
export function normalizePreferredGuideUrl(raw) {
  const cleaned = cleanGuideUrl(raw);
  if (!cleaned) return "";
  return canonicalGamefaqsBundleUrl(cleaned) ?? cleaned;
}

/**
 * True when URL is a GameFAQs FAQ root (not a chapter URL).
 * @param {string} url
 * @returns {boolean}
 */
export function isGamefaqsBundleUrl(url) {
  const parsed = parseGamefaqsFaqUrl(url);
  if (!parsed) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === new URL(parsed.canonicalUrl).pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

/**
 * True when a preferred guide is a confirmed multi-page GameFAQs bundle
 * (not merely a FAQ root URL shape).
 * @param {string} url
 * @param {{ pageCount?: number; pages?: unknown[]; selectedSlugs?: string[] } | undefined} meta
 * @returns {boolean}
 */
export function isActiveGamefaqsBundle(url, meta) {
  if (!isGamefaqsBundleUrl(url)) return false;
  const count =
    meta?.pageCount ??
    meta?.selectedSlugs?.length ??
    meta?.pages?.length ??
    0;
  return count > 1;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSamePreferredGuide(a, b) {
  if (!a || !b) return false;
  const left = guideUrlDedupeKey(a);
  const right = guideUrlDedupeKey(b);
  if (left && right && left === right) return true;
  return sameGamefaqsBundle(a, b);
}

/**
 * Stable dedupe key for guide URLs (www, trailing slash, case).
 * @param {string} raw
 * @returns {string}
 */
export function guideUrlDedupeKey(raw) {
  const cleaned = normalizePreferredGuideUrl(raw);
  if (!cleaned) return "";
  try {
    const parsed = new URL(cleaned);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return cleaned;
  }
}

/**
 * Dedupe guide URLs (case-insensitive host + path) and cap the list.
 * @param {string[]} urls
 * @param {number} [max]
 * @returns {string[]}
 */
export function normalizeGuideUrlList(urls, max = MAX_GUIDE_URLS) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const cleaned = normalizePreferredGuideUrl(raw);
    if (!cleaned) continue;
    const key = guideUrlDedupeKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Coerce preferred guide URLs from an API/request body.
 * Accepts `preferredUrls` (array) and legacy `preferredUrl` (string).
 * @param {Record<string, unknown>} record
 * @returns {string[]}
 */
export function coerceGuideUrlsFromBody(record) {
  const fromArray = Array.isArray(record.preferredUrls)
    ? record.preferredUrls.flatMap((item) => {
        const url = cleanGuideUrl(item);
        return url ? [url] : [];
      })
    : [];
  const legacy = cleanGuideUrl(record.preferredUrl);
  return normalizeGuideUrlList(legacy && !fromArray.length ? [legacy, ...fromArray] : fromArray);
}

/**
 * Read guide URLs from a saved chat row (array column with legacy string fallback).
 * @param {GuideUrlRow | null | undefined} chat
 * @returns {string[]}
 */
export function guideUrlsFromChat(chat) {
  if (!chat) return [];
  const fromArray = Array.isArray(chat.preferred_guide_urls)
    ? chat.preferred_guide_urls.flatMap((item) => {
        const url = cleanGuideUrl(item);
        return url ? [url] : [];
      })
    : [];
  if (fromArray.length) return normalizeGuideUrlList(fromArray);
  const legacy = cleanGuideUrl(chat.preferred_guide_url);
  return legacy ? [legacy] : [];
}

/**
 * Coerce guide URLs from a session draft (array with legacy single-string fallback).
 * @param {Record<string, unknown>} draft
 * @returns {string[]}
 */
export function guideUrlsFromDraft(draft) {
  const fromArray = Array.isArray(draft.preferredUrls)
    ? draft.preferredUrls.flatMap((item) => {
        const url = cleanGuideUrl(item);
        return url ? [url] : [];
      })
    : [];
  const legacy = cleanGuideUrl(draft.preferredUrl);
  return normalizeGuideUrlList(legacy && !fromArray.length ? [legacy, ...fromArray] : fromArray);
}

/**
 * @param {string[]} urls
 * @returns {{ preferred_guide_url: string; preferred_guide_urls: string[] }}
 */
export function guideUrlsPayload(urls) {
  const normalized = normalizeGuideUrlList(urls);
  return {
    preferred_guide_url: normalized[0] ?? "",
    preferred_guide_urls: normalized,
  };
}

/**
 * @param {string[]} urls
 * @param {Record<string, { pageCount?: number; pages?: unknown[]; selectedSlugs?: string[] }>} [metaByUrl]
 * @returns {string}
 */
export function guideUrlsSummary(urls, metaByUrl = {}) {
  if (!urls.length) return "";
  if (urls.length === 1) {
    if (isActiveGamefaqsBundle(urls[0], metaByUrl[urls[0]])) return "GameFAQs bundle";
    try {
      return new URL(urls[0]).hostname.replace(/^www\./, "");
    } catch {
      return urls[0];
    }
  }
  return `${urls.length} guides`;
}
