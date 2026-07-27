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
  // Synthetic upload keys are not http(s) URLs but are valid preferred guides.
  if (trimmed.startsWith("upload://")) return trimmed;
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
 * True when URL is a GameFAQs FAQ (root or section — stored under canonical root).
 * @param {string} url
 * @returns {boolean}
 */
export function isGamefaqsFaqGuideUrl(url) {
  return Boolean(parseGamefaqsFaqUrl(url));
}

/** @deprecated use isGamefaqsFaqGuideUrl */
/** @param {string} url */
export function isGamefaqsBundleUrl(url) {
  return isGamefaqsFaqGuideUrl(url);
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
  // Synthetic upload:// keys are already canonical — pass through.
  if (typeof raw === "string" && raw.startsWith("upload://")) return raw;
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
 * Merge persisted chat URLs with in-memory room state.
 * In-memory-only URLs win (guide added before row/DB caught up); otherwise chat
 * is authoritative so a saved removal is not resurrected from stale React state.
 * @param {string[]} fromChat
 * @param {string[]} inMemory
 * @returns {string[]}
 */
export function mergeRoomPreferredUrls(fromChat, inMemory) {
  const chat = normalizeGuideUrlList(fromChat);
  const memory = normalizeGuideUrlList(inMemory);
  const chatKeys = new Set(chat.map(guideUrlDedupeKey));
  const hasMemoryOnly = memory.some((url) => !chatKeys.has(guideUrlDedupeKey(url)));
  if (hasMemoryOnly) return normalizeGuideUrlList([...chat, ...memory]);
  return chat;
}

/**
 * @param {string} url
 * @returns {string}
 */
export function guideUrlHostLabel(url) {
  if (isUploadedGuideUrl(url)) return uploadedGuideFilename(url);
  if (isGamefaqsFaqGuideUrl(url)) return "GameFAQs guide";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Answer-source / footnote label for a linked preferred guide URL. @param {string} url */
export function guideSourceLinkLabel(url) {
  if (isGamefaqsFaqGuideUrl(url)) return "GameFAQs guide";
  return guideUrlHostLabel(url);
}

/**
 * @param {string[]} urls
 * @returns {string}
 */
export function guideUrlsSummary(urls) {
  if (!urls.length) return "";
  if (urls.length === 1) {
    if (isUploadedGuideUrl(urls[0])) return uploadedGuideFilename(urls[0]);
    if (isGamefaqsFaqGuideUrl(urls[0])) return "GameFAQs guide";
    return guideUrlHostLabel(urls[0]);
  }
  const uploads = urls.filter(isUploadedGuideUrl);
  const links = urls.filter((url) => !isUploadedGuideUrl(url));
  if (uploads.length && links.length) {
    const uploadPart =
      uploads.length === 1
        ? `${uploadedGuideFileTypeLabel(uploads[0])} · ${uploadedGuideFilename(uploads[0])}`
        : `${uploads.length} files`;
    const linkPart =
      links.length === 1
        ? guideUrlHostLabel(links[0])
        : `${links.length} links`;
    return `${uploadPart} + ${linkPart}`;
  }
  return `${urls.length} guides`;
}

/** 
 * True if the guide_url is a synthetic upload:// key (not a fetchable URL).
 * @param {unknown} url
 */
export function isUploadedGuideUrl(url) {
  return typeof url === "string" && url.startsWith("upload://");
}

/** 
 * Extract display filename from upload://uid/filename.pdf → "filename.pdf"
 * @param {string} url 
 */
export function uploadedGuideFilename(url) {
  if (!isUploadedGuideUrl(url)) return "";
  const raw = url.split("/").pop() || "Uploaded guide";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * File type label for an uploaded guide URL.
 * upload://uid/file.pdf → "PDF", .txt → "TXT", .md → "MD"
 * @param {string} url
 * @returns {string}
 */
export function uploadedGuideFileTypeLabel(url) {
  if (!isUploadedGuideUrl(url)) return "";
  const ext = url.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "PDF";
  if (ext === "txt") return "TXT";
  if (ext === "md") return "MD";
  return "Uploaded";
}
