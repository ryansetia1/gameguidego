/**
 * GameFAQs FAQ URL helpers. Ingest uses ?print=1 via Tavily (see lib/tavily.ts).
 */

const GAMEFAQS_HOSTS = new Set(["gamefaqs.gamespot.com", "www.gamefaqs.gamespot.com"]);

/**
 * @param {string} rawUrl
 * @returns {{
 *   host: string;
 *   faqId: string;
 *   platformSlug: string;
 *   gameSlug: string;
 *   sectionSlug: string | null;
 *   canonicalUrl: string;
 *   bundleKey: string;
 * } | null}
 */
export function parseGamefaqsFaqUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!GAMEFAQS_HOSTS.has(host)) return null;

  const match = parsed.pathname.match(
    /^\/([^/]+)\/(\d+)-([^/]+)\/faqs\/(\d+)(?:\/([^/]+))?\/?$/i,
  );
  if (!match) return null;

  const [, platformSlug, , gameSlug, faqId, sectionSlug] = match;
  const basePath = `/${platformSlug}/${match[2]}-${gameSlug}/faqs/${faqId}`;
  const canonicalUrl = `https://gamefaqs.gamespot.com${basePath}`;

  return {
    host,
    faqId,
    platformSlug,
    gameSlug,
    sectionSlug: sectionSlug ? sectionSlug.toLowerCase() : null,
    canonicalUrl,
    bundleKey: `gamefaqs:${faqId}`,
  };
}

/**
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isGamefaqsFaqUrl(rawUrl) {
  return parseGamefaqsFaqUrl(rawUrl) !== null;
}

/**
 * GameFAQs print-view URL for ingest extract (`?print=1`).
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function gamefaqsPrintExtractUrl(rawUrl) {
  if (!isGamefaqsFaqUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.get("print") === "1") return parsed.toString();
    parsed.searchParams.set("print", "1");
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Live/Wayback extract targets for a GameFAQs FAQ: ?print=1 first, then FAQ root.
 * ponytail: print=1 archives are often missing while the paginated page is saved.
 * @param {string} rawUrl
 * @returns {string[]}
 */
export function gamefaqsWaybackExtractTargets(rawUrl) {
  if (!isGamefaqsFaqUrl(rawUrl)) {
    try {
      return [new URL(rawUrl).toString()];
    } catch {
      return [rawUrl];
    }
  }
  const canonical = canonicalGamefaqsBundleUrl(rawUrl);
  if (!canonical) return [rawUrl];
  const print = gamefaqsPrintExtractUrl(canonical);
  /** @type {string[]} */
  const targets = [];
  if (print) targets.push(print);
  if (!targets.includes(canonical)) targets.push(canonical);
  return targets;
}

/**
 * Normalize any GameFAQs FAQ page URL to the FAQ root (no section slug).
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function canonicalGamefaqsBundleUrl(rawUrl) {
  return parseGamefaqsFaqUrl(rawUrl)?.canonicalUrl ?? null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameGamefaqsBundle(a, b) {
  const left = parseGamefaqsFaqUrl(a);
  const right = parseGamefaqsFaqUrl(b);
  return Boolean(left && right && left.bundleKey === right.bundleKey);
}

/** ponytail: full ?print=1 walkthroughs are huge; Tavily index false positives sit ~3–8k. */
export const MIN_GAMEFAQS_GUIDE_CHARS = 20_000;

/**
 * Minimum body length for a genuinely small real guide (short FAQ, mini boss guide).
 * Below this an extract is near-empty, not a real guide.
 */
export const MIN_GUIDE_BODY_CHARS = 400;

/**
 * True when Tavily extract looks like GameFAQs nav + TOC, not walkthrough body.
 * @param {string} text
 * @returns {boolean}
 */
export function isGamefaqsTocOnlyExtract(text) {
  if (!text || text.length >= MIN_GAMEFAQS_GUIDE_CHARS) return false;

  const partHeaders = (text.match(/\bPart\s+\d+\s*:/gi) || []).length;
  const numberedSections = (text.match(/^\s*\d+\.\s+\S.{4,}/gm) || []).length;
  const hasNav =
    /\*?\s*Home\s*\*?\s*Boards|Boards\s*\*?\s*News|gamefaqs\.gamespot\.com\/boards/i.test(
      text,
    );
  const longLines = text.split(/\n+/).filter((line) => line.trim().length >= 100).length;

  const tocHeavy = partHeaders >= 2 || numberedSections >= 4;
  const shallow = longLines < 6;

  return (hasNav || tocHeavy) && tocHeavy && shallow;
}

/**
 * @param {string} text
 * @returns {{ insufficient: boolean, reason: 'too_short' | 'toc_only' | null }}
 */
export function gamefaqsExtractQuality(text) {
  if (!text) return { insufficient: true, reason: "too_short" };
  // TOC-only is the real signal to reject (catches ~3–8k nav/index extracts).
  if (isGamefaqsTocOnlyExtract(text)) {
    return { insufficient: true, reason: "toc_only" };
  }
  // ponytail: raw length is a weak proxy that punishes small real guides. Accept
  // any non-TOC body ≥ MIN_GUIDE_BODY_CHARS; reserve too_short for near-empty.
  // Ceiling: on the first try we can't tell "small real guide" from "transient
  // thin extract" — accept it and let a later fuller extract replace it via the
  // quality re-ingest path in guide-ingest.ts.
  if (text.length < MIN_GUIDE_BODY_CHARS) {
    return { insufficient: true, reason: "too_short" };
  }
  return { insufficient: false, reason: null };
}

/**
 * @param {string} gameSlug
 * @returns {string}
 */
function titleFromGamefaqsGameSlug(gameSlug) {
  return gameSlug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @param {string} title
 * @param {{ gameSlug?: string } | null | undefined} parsed
 * @returns {string}
 */
function withGamefaqsGamePrefix(title, parsed) {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed || !parsed?.gameSlug) return trimmed.slice(0, 120);
  const game = titleFromGamefaqsGameSlug(parsed.gameSlug);
  const gameToken = game.split(" ")[0].toLowerCase();
  if (trimmed.toLowerCase().includes(gameToken)) return trimmed.slice(0, 120);
  return `${game} — ${trimmed}`.slice(0, 120);
}

/**
 * @param {string} html
 * @param {{ gameSlug?: string } | null} [parsed]
 * @returns {string}
 */
export function parseGamefaqsGuideTitle(html, parsed = null) {
  if (!html) return "";

  const text = html.replace(/\*\*/g, "");

  const mdH1 = text.match(/^#\s+(.+?)\s+by\s+([A-Za-z0-9_.-]+)/im);
  if (mdH1) {
    const guideType = mdH1[1].replace(/\s+/g, " ").trim();
    const author = mdH1[2].trim();
    const titled = author ? `${guideType} by ${author}` : guideType;
    return withGamefaqsGamePrefix(titled, parsed);
  }

  const guideByLine = text.match(
    /(?:^|[\n#>])\s*((?:Guide and Walkthrough|FAQ and Walkthrough|Walkthrough)[^|\n]{0,80}?)\s+by\s+(?:\[([^\]]+)\]\([^)]*\)|([A-Za-z0-9_.-]+))/im,
  );
  if (guideByLine) {
    const guideType = guideByLine[1].replace(/\s+/g, " ").trim();
    const author = (guideByLine[2] || guideByLine[3] || "").trim();
    const titled = author ? `${guideType} by ${author}` : guideType;
    return withGamefaqsGamePrefix(titled, parsed);
  }

  const guideByNextLine = text.match(
    /((?:Guide and Walkthrough|FAQ and Walkthrough)[^|\n]{0,80}?)\s*\n+\s*by\s+(?:\[([^\]]+)\]|([A-Za-z0-9_.-]+))/im,
  );
  if (guideByNextLine) {
    const guideType = guideByNextLine[1].replace(/\s+/g, " ").trim();
    const author = (guideByNextLine[2] || guideByNextLine[3] || "").trim();
    const titled = author ? `${guideType} by ${author}` : guideType;
    return withGamefaqsGamePrefix(titled, parsed);
  }

  const emDashGuide = text.match(
    /([A-Za-z][A-Za-z0-9' ]{1,40})\s*[—–]\s*((?:Guide and Walkthrough|FAQ and Walkthrough)\s*\([^)]+\)[^|\n]{0,40}?)(?:\s+by\s+(?:\[([^\]]+)\]|([A-Za-z0-9_.-]+)))?/i,
  );
  if (emDashGuide) {
    const game = emDashGuide[1].replace(/\s+/g, " ").trim();
    const guideType = emDashGuide[2].replace(/\s+/g, " ").trim();
    const author = (emDashGuide[3] || emDashGuide[4] || "").trim();
    let titled = author ? `${guideType} by ${author}` : guideType;
    if (game && !titled.toLowerCase().includes(game.split(" ")[0].toLowerCase())) {
      titled = `${game} — ${titled}`;
    }
    return titled.slice(0, 120);
  }

  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    let cleaned = title[1]
      .replace(/\s*-\s*GameFAQs.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    cleaned = cleaned.replace(/^[^—-]+ [-—] /, "");
    if (cleaned && !/^gamefaqs guide$/i.test(cleaned.trim())) {
      return withGamefaqsGamePrefix(cleaned, parsed);
    }
  }

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const heading = h1[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (heading && !/^gamefaqs guide$/i.test(heading)) {
      return withGamefaqsGamePrefix(heading, parsed);
    }
  }

  return "";
}
