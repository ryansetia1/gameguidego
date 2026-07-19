/**
 * GameFAQs multi-page FAQ bundle detection and TOC discovery.
 * ponytail: GameFAQs-only expander; other sites stay single-page until we add
 * another provider-specific parser.
 */

export const MAX_BUNDLE_PAGES = 50;

const GAMEFAQS_HOSTS = new Set(["gamefaqs.gamespot.com", "www.gamefaqs.gamespot.com"]);

/** Slugs we never index from a FAQ TOC. */
const SKIP_SLUG_RE =
  /^(boards|board|messages?|map|maps|contribute|updates?|legal|copyright)$/i;

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
 * Normalize any GameFAQs FAQ page URL to the bundle root (no section slug).
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

/**
 * @param {string} slug
 * @returns {boolean}
 */
export function shouldSkipGamefaqsSlug(slug) {
  return !slug || SKIP_SLUG_RE.test(slug);
}

/**
 * Humanize a GameFAQs section slug into a short title.
 * @param {string} slug
 * @returns {string}
 */
export function titleFromGamefaqsSlug(slug) {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Parse FAQ TOC links from a GameFAQs HTML page.
 * @param {string} html
 * @param {{ faqId: string; canonicalUrl: string }} bundle
 * @returns {{ title: string; url: string; slug: string }[]}
 */
export function parseGamefaqsTocFromHtml(html, bundle) {
  if (!html || !bundle?.faqId) return [];

  const seen = new Set();
  const pages = [];
  const pathPattern = new RegExp(
    `\\/faqs\\/${bundle.faqId}\\/([a-z0-9][a-z0-9-]*)`,
    "gi",
  );

  let match;
  while ((match = pathPattern.exec(html)) !== null) {
    const slug = match[1].toLowerCase();
    if (shouldSkipGamefaqsSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    pages.push({
      slug,
      title: titleFromGamefaqsSlug(slug),
      url: `${bundle.canonicalUrl}/${slug}`,
    });
    if (pages.length >= MAX_BUNDLE_PAGES) break;
  }

  pages.sort((a, b) => gamefaqsPageOrder(a.slug) - gamefaqsPageOrder(b.slug) || a.title.localeCompare(b.title));
  return pages;
}

/**
 * @param {string} slug
 * @returns {number}
 */
export function gamefaqsPageOrder(slug) {
  if (slug === "introduction") return 0;
  if (slug === "frequently-asked-questions" || slug === "faq") return 1;
  if (slug === "controls" || slug === "control") return 2;
  const walk = slug.match(/^walkthrough(?:-part)?-(\d+)$/i);
  if (walk) return 10 + Number(walk[1]);
  const part = slug.match(/^part-(\d+)(?:-|$)/i);
  if (part) return 10 + Number(part[1]);
  if (slug.startsWith("walkthrough")) return 20;
  if (slug.includes("boss")) return 40;
  if (slug.includes("star")) return 50;
  if (slug.includes("item") || slug.includes("equipment") || slug.includes("rune")) {
    return 60;
  }
  return 30;
}

/**
 * Shared search terms for GameFAQs bundle discovery (Tavily rejects site:-only queries).
 * @param {{ gameSlug: string; faqId: string }} parsed
 * @returns {string}
 */
export function gamefaqsDiscoveryTerms(parsed) {
  const game = parsed.gameSlug.replace(/-/g, " ");
  return `${game} faq ${parsed.faqId}`;
}

/**
 * Base Tavily site-search queries for a GameFAQs FAQ bundle.
 * @param {{ canonicalUrl: string; gameSlug: string; faqId: string }} parsed
 * @returns {string[]}
 */
export function buildGamefaqsDiscoveryBaseQueries(parsed) {
  const path = new URL(parsed.canonicalUrl).pathname;
  const terms = gamefaqsDiscoveryTerms(parsed);
  return [
    `${terms} walkthrough`,
    `${terms} "${path}"`,
    `${terms} "${path}/part-"`,
    `${terms} "${path}/walkthrough"`,
    `${terms} "${path}/boss"`,
    `${terms} "${path}/faq"`,
    `${path.replace(/\//g, " ")} walkthrough`,
    `gamefaqs ${terms}`,
  ];
}

/**
 * Per-part site-search queries when the base pass finds too few pages.
 * @param {{ canonicalUrl: string; gameSlug: string; faqId: string }} parsed
 * @param {number} [maxPart]
 * @returns {string[]}
 */
export function buildGamefaqsPartDiscoveryQueries(parsed, maxPart = 25) {
  const path = new URL(parsed.canonicalUrl).pathname;
  const terms = gamefaqsDiscoveryTerms(parsed);
  const queries = [];
  for (let n = 1; n <= maxPart; n += 1) {
    queries.push(`${terms} "${path}/part-${n}"`);
    if (n <= 15) {
      queries.push(`${terms} "${path}/walkthrough-part-${n}"`);
    }
  }
  for (const slug of [
    "introduction",
    "frequently-asked-questions",
    "faq",
    "controls",
    "boss-guides",
    "boss-guide",
    "equipment",
    "items",
    "secrets",
    "endings",
  ]) {
    queries.push(`${terms} "${path}/${slug}"`);
  }
  return queries;
}

/**
 * Build bundle page list from search-hit URLs.
 * @param {string[]} urls
 * @param {{ faqId: string; canonicalUrl: string }} bundle
 * @returns {{ title: string; url: string; slug: string }[]}
 */
export function parseGamefaqsPagesFromUrls(urls, bundle) {
  if (!bundle?.faqId || !Array.isArray(urls)) return [];

  const seen = new Set();
  const pages = [];
  const pathPattern = new RegExp(
    `\\/faqs\\/${bundle.faqId}\\/([a-z0-9][a-z0-9-]*)`,
    "i",
  );

  const pathPrefix = `${new URL(bundle.canonicalUrl).pathname.replace(/\/+$/, "")}/`.toLowerCase();

  for (const raw of urls) {
    let pathname = "";
    try {
      pathname = new URL(raw).pathname;
    } catch {
      continue;
    }
    if (!pathname.toLowerCase().startsWith(pathPrefix)) continue;
    const match = pathname.match(pathPattern);
    if (!match) continue;
    const slug = match[1].toLowerCase();
    if (shouldSkipGamefaqsSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    pages.push({
      slug,
      title: titleFromGamefaqsSlug(slug),
      url: `${bundle.canonicalUrl}/${slug}`,
    });
    if (pages.length >= MAX_BUNDLE_PAGES) break;
  }

  pages.sort(
    (a, b) => gamefaqsPageOrder(a.slug) - gamefaqsPageOrder(b.slug) || a.title.localeCompare(b.title),
  );
  return pages;
}

/**
 * Dedupe and sort bundle page rows from multiple discovery passes.
 * @param {{ title: string; url: string; slug: string }[]} pages
 * @returns {{ title: string; url: string; slug: string }[]}
 */
export function mergeGamefaqsBundlePages(pages) {
  if (!Array.isArray(pages)) return [];
  const seen = new Set();
  const out = [];
  for (const page of pages) {
    if (!page?.slug || seen.has(page.slug)) continue;
    seen.add(page.slug);
    out.push(page);
    if (out.length >= MAX_BUNDLE_PAGES) break;
  }
  out.sort(
    (a, b) => gamefaqsPageOrder(a.slug) - gamefaqsPageOrder(b.slug) || a.title.localeCompare(b.title),
  );
  return out;
}

/**
 * @param {string} pageUrl
 * @param {string} faqId
 * @returns {string}
 */
export function slugFromGamefaqsPageUrl(pageUrl, faqId) {
  try {
    const match = new URL(pageUrl).pathname.match(
      new RegExp(`/faqs/${faqId}/([a-z0-9][a-z0-9-]*)`, "i"),
    );
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * @param {string} gameSlug
 * @returns {string}
 */
export function titleFromGamefaqsGameSlug(gameSlug) {
  return gameSlug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * @param {string | undefined | null} title
 * @returns {boolean}
 */
export function isGenericGamefaqsBundleTitle(title) {
  return !title || /^gamefaqs guide$/i.test(String(title).trim());
}

/**
 * Prefer a specific bundle title over the generic fallback.
 * @param {string | undefined} left
 * @param {string | undefined} right
 * @returns {string}
 */
export function pickGamefaqsBundleTitle(left, right) {
  if (left && !isGenericGamefaqsBundleTitle(left)) return left.trim().slice(0, 120);
  if (right && !isGenericGamefaqsBundleTitle(right)) return right.trim().slice(0, 120);
  return (left || right || "GameFAQs guide").trim().slice(0, 120);
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
    if (cleaned && !isGenericGamefaqsBundleTitle(cleaned)) {
      return withGamefaqsGamePrefix(cleaned, parsed);
    }
  }

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = h1[1]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && !isGenericGamefaqsBundleTitle(text)) {
      return withGamefaqsGamePrefix(text, parsed);
    }
  }

  return "";
}

/**
 * Discover all pages in a GameFAQs FAQ bundle.
 * @param {string} rawUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<{
 *   bundle: boolean;
 *   provider?: string;
 *   bundleKey?: string;
 *   canonicalUrl?: string;
 *   title?: string;
 *   pageCount?: number;
 *   pages?: { title: string; url: string; slug: string }[];
 * }>}
 */
export async function discoverGamefaqsBundle(rawUrl, signal) {
  const parsed = parseGamefaqsFaqUrl(rawUrl);
  if (!parsed) return { bundle: false };

  const fetchUrl = parsed.sectionSlug
    ? rawUrl
    : `${parsed.canonicalUrl}/introduction`;

  let html = "";
  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "GameGuideGo/1.0 (preferred guide indexing)",
      },
      signal,
      redirect: "follow",
    });
    if (!response.ok) {
      return { bundle: false };
    }
    html = await response.text();
  } catch {
    return { bundle: false };
  }

  const pages = parseGamefaqsTocFromHtml(html, parsed);
  if (pages.length <= 1) {
    return { bundle: false };
  }

  return {
    bundle: true,
    provider: "gamefaqs",
    bundleKey: parsed.bundleKey,
    canonicalUrl: parsed.canonicalUrl,
    title: parseGamefaqsGuideTitle(html, parsed) || "GameFAQs guide",
    pageCount: pages.length,
    pages,
  };
}
