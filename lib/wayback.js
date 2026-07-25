import { cleanSnippet } from "./clean.js";
import { parseGamefaqsFaqUrl, parseGamefaqsGuideTitle } from "./gamefaqs-bundle.js";

/** @param {string} canonicalUrl @param {AbortSignal | undefined} [signal] */
export async function fetchGamefaqsWaybackRootTitle(canonicalUrl, signal) {
  const parsed = parseGamefaqsFaqUrl(canonicalUrl);
  if (!parsed) return "";

  const timestamp = await waybackClosestTimestamp(canonicalUrl, signal);
  if (!timestamp) return "";

  try {
    const response = await fetch(waybackIdFetchUrl(waybackSnapshotUrl(timestamp, canonicalUrl)), {
      signal: signal ?? undefined,
      headers: {
        "User-Agent": "GameGuideGo/1.0 (guide-ingest)",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return "";
    return parseGamefaqsGuideTitle(await response.text(), parsed);
  } catch {
    return "";
  }
}

/** ponytail: large GameFAQs FAQs can hit ~100 TOC sections; cap avoids unbounded Wayback crawl. */
export const MAX_WAYBACK_GAMEFAQS_SECTIONS = 100;

const WAYBACK_SECTION_BATCH = 5;

/** @param {unknown} payload */
export function parseWaybackAvailability(payload) {
  if (!payload || typeof payload !== "object") return null;
  const closest = /** @type {{ available?: boolean; timestamp?: unknown }} */ (
    /** @type {{ archived_snapshots?: { closest?: { available?: boolean; timestamp?: unknown } } }} */ (
      payload
    ).archived_snapshots?.closest
  );
  if (!closest?.available || typeof closest.timestamp !== "string") return null;
  return closest.timestamp;
}

/** @param {string} timestamp @param {string} target */
export function waybackSnapshotUrl(timestamp, target) {
  return `https://web.archive.org/web/${timestamp}/${target}`;
}

/**
 * @param {string} target
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string | null>}
 */
export async function waybackClosestTimestamp(target, signal) {
  try {
    const response = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`,
      { signal: signal ?? undefined, headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    return parseWaybackAvailability(await response.json());
  } catch {
    return null;
  }
}

/**
 * Wayback URLs to try: web/2/ first, then explicit snapshot when known.
 * @param {string} target
 * @param {string | null} borrowTimestampFrom canonical FAQ URL when print=1 has no archive
 * @param {AbortSignal | undefined} signal
 */
export async function waybackUrlsForTarget(target, borrowTimestampFrom, signal) {
  /** @type {string[]} */
  const urls = [`https://web.archive.org/web/2/${target}`];
  let timestamp = await waybackClosestTimestamp(target, signal);
  let borrowed = false;
  if (!timestamp && borrowTimestampFrom && target.includes("print=1")) {
    timestamp = await waybackClosestTimestamp(borrowTimestampFrom, signal);
    borrowed = Boolean(timestamp);
  }
  if (timestamp) {
    const snap = waybackSnapshotUrl(timestamp, target);
    if (!urls.includes(snap)) urls.push(snap);
  }
  return { urls, borrowed };
}

/**
 * ponytail: GameFAQs body is #faqwrap on archived pages; #faqtext is print-view only.
 * @param {string} html
 * @returns {string | null}
 */
export function extractGamefaqsFaqHtml(html) {
  if (typeof html !== "string") return null;
  const match =
    html.match(/<div id="faqwrap"[^>]*>([\s\S]*?)<div class="pod"/i) ||
    html.match(/<div id="faqtext"[^>]*>([\s\S]*?)<\/div>\s*<div class="faq_footer"/i) ||
    html.match(/<div id="faqtext"[^>]*>([\s\S]*?)<\/div>\s*<div class="pod"/i);
  return match?.[1] ?? null;
}

/** @param {string} html @returns {string[]} */
export function parseGamefaqsTocSlugs(html) {
  const ftoc = html.match(/<div class="ftoc">[\s\S]*?<\/div>/i)?.[0];
  if (!ftoc) return [];
  /** @type {string[]} */
  const slugs = [];
  for (const match of ftoc.matchAll(/href="([^"#][^"]*)"/gi)) {
    const slug = match[1].trim();
    if (!slug || slug.startsWith("http") || slug.startsWith("/")) continue;
    slugs.push(slug);
  }
  return [...new Set(slugs)];
}

/** @param {string} canonicalUrl @param {string} slug */
export function gamefaqsSectionUrl(canonicalUrl, slug) {
  return `${canonicalUrl.replace(/\/$/, "")}/${slug}`;
}

/** @param {string} waybackUrl @returns {string | null} */
export function waybackTimestampFromUrl(waybackUrl) {
  const match = waybackUrl.match(/\/web\/(\d{8,})/);
  return match?.[1] ?? null;
}

/**
 * @param {string} waybackUrl
 * @param {string} canonicalUrl
 * @param {AbortSignal | undefined} signal
 */
export async function fetchGamefaqsWaybackMulti(waybackUrl, canonicalUrl, signal) {
  const timestamp = waybackTimestampFromUrl(waybackUrl);
  if (!timestamp) return null;

  let rootHtml = "";
  try {
    const response = await fetch(waybackIdFetchUrl(waybackUrl), {
      signal: signal ?? undefined,
      headers: {
        "User-Agent": "GameGuideGo/1.0 (guide-ingest)",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    rootHtml = await response.text();
  } catch {
    return null;
  }

  const slugs = parseGamefaqsTocSlugs(rootHtml).slice(0, MAX_WAYBACK_GAMEFAQS_SECTIONS);
  if (slugs.length < 2) return null;

  /** @type {string[]} */
  const parts = [];
  const rootText = htmlToGuideText(rootHtml, { gamefaqs: true });
  if (rootText) parts.push(rootText);

  for (let i = 0; i < slugs.length; i += WAYBACK_SECTION_BATCH) {
    const batch = slugs.slice(i, i + WAYBACK_SECTION_BATCH);
    const batchTexts = await Promise.all(
      batch.map(async (slug) => {
        const sectionUrl = gamefaqsSectionUrl(canonicalUrl, slug);
        const snap = waybackSnapshotUrl(timestamp, sectionUrl);
        return fetchWaybackPageText(snap, signal);
      }),
    );
    for (const text of batchTexts) {
      if (text) parts.push(text);
    }
  }

  const parsed = parseGamefaqsFaqUrl(canonicalUrl);
  const guideTitle = parsed ? parseGamefaqsGuideTitle(rootHtml, parsed) : "";

  let combined = cleanSnippet(parts.join("\n\n"));
  if (guideTitle) {
    combined = cleanSnippet(`${guideTitle}\n\n${combined}`);
  }
  return combined.length >= 60 ? combined : null;
}

/**
 * ponytail: naive HTML→text for Wayback when Tavily Extract returns empty/thin.
 * @param {string} html
 * @param {{ gamefaqs?: boolean }} [opts]
 */
export function htmlToGuideText(html, opts = {}) {
  if (typeof html !== "string") return "";
  const faqHtml = opts.gamefaqs ? extractGamefaqsFaqHtml(html) : null;
  const source = faqHtml ?? html;
  return cleanSnippet(
    source
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** @param {string} waybackUrl */
export function waybackIdFetchUrl(waybackUrl) {
  if (/\/web\/\d+id_\//.test(waybackUrl)) return waybackUrl;
  const idUrl = waybackUrl.replace(/\/web\/(\d+)\//, "/web/$1id_/");
  return idUrl !== waybackUrl ? idUrl : waybackUrl;
}

/**
 * @param {string} waybackUrl
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string | null>}
 */
export async function fetchWaybackPageText(waybackUrl, signal) {
  try {
    const fetchUrl = waybackIdFetchUrl(waybackUrl);
    const gamefaqs = fetchUrl.includes("gamefaqs.gamespot.com");
    const response = await fetch(fetchUrl, {
      signal: signal ?? undefined,
      headers: {
        "User-Agent": "GameGuideGo/1.0 (guide-ingest)",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    const text = htmlToGuideText(await response.text(), { gamefaqs });
    return text.length >= 60 ? text : null;
  } catch {
    return null;
  }
}
