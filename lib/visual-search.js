/** @typedef {{ title: string; imageUrl: string; link?: string; domain?: string }} SerperImageHit */
/** @typedef {{ url: string; alt: string; sourceUrl?: string }} VisualIllustration */

const IMAGE_BLOCK_HOSTS = [
  "pinterest.",
  "shutterstock.",
  "gettyimages.",
  "istockphoto.",
  "alamy.",
  "dreamstime.",
  "depositphotos.",
  "vectorstock.",
  "spriters-resource.com",
  "models.spriters-resource.com",
  "gamestop.",
  "amazon.",
  "etsy.",
];

const PREFERRED_IMAGE_HOSTS = [
  "fandom.com",
  "wikia.com",
  "zeldawiki.wiki",
  "strategywiki.org",
  "game8.co",
  "neoseeker.com",
  "nintendo.com",
  "steamstatic.com",
];

const GUIDE_ARTICLE_HINTS =
  /\b(walkthrough|how\s+to\s+get|guide\s+and|faq|part\s+\d+|youtube|gamefaqs)\b/i;

const COVER_ART_HINTS =
  /\b(cover(?:\s+art)?|box\s*art|cartridge|greatest\s*hits|gamestop|amazon|pricecharting|replacement\s*label|decal\s*sticker|retro[\s-]?gaming|video\s*games|pal\s*playstation|nintendo\s*store|eshop|game\s*case)\b/i;

/** @param {string} platform */
function platformTokens(platform) {
  return tokenize(platform).filter((token) => token.length > 2);
}

const TOPIC_STOPWORDS = new Set([
  "ada",
  "gak",
  "ga",
  "kamu",
  "kmu",
  "gambarnya",
  "wujudnya",
  "gimana",
  "kaya",
  "kayak",
  "punya",
  "the",
  "and",
  "for",
  "you",
  "your",
  "have",
  "any",
  "image",
  "picture",
]);

/**
 * Split a web-rewrite output into the search query and an optional visual subject.
 * The rewrite (REWRITE_INSTRUCTION) appends a trailing `VISUAL: <subject>` line only
 * when the player is asking what something looks like — so its absence means "not a
 * visual question". Language-neutral: the rewrite has already translated intent to
 * English before tagging. A garbled/missing tag degrades to no image search.
 *
 * @param {string} raw
 * @returns {{ searchTopic: string; visualSubject: string | null }}
 */
export function parseRewriteVisual(raw) {
  const text = String(raw || "");
  const match = text.match(/(?:^|\n)\s*VISUAL\s*:\s*(.+?)\s*$/im);
  let visualSubject = null;
  if (match) {
    const subject = match[1].replace(/\s+/g, " ").trim();
    if (subject) visualSubject = subject.slice(0, 80);
  }
  const searchTopic = text
    .replace(/(?:^|\n)\s*VISUAL\s*:.*$/im, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  return { searchTopic, visualSubject };
}

const VISUAL_QUERY_BANNED =
  /\b(icon|icons|sprite|sprites|image|images|picture|pictures|wallpaper|wallpapers|render|renders|artwork|fanart|screenshot|screenshots|png|jpg|jpeg|webp|gif)\b/gi;

/**
 * Strip search-noise tokens models or heuristics may add.
 * @param {string} query
 */
export function sanitizeVisualSearchQuery(query) {
  return String(query || "")
    .replace(VISUAL_QUERY_BANNED, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} game
 * @param {string} platform
 * @param {string} subject Short item name, not a full RAG rewrite paragraph.
 */
export function buildVisualSearchQuery(game, platform, subject) {
  const subjectText = String(subject || "").trim();
  // Drop game/platform if the subject already names them, so a subject like
  // "False Knight Hollow Knight" + game "Hollow Knight" doesn't double the title.
  const subjectPadded = ` ${subjectText.toLowerCase()} `;
  const parts = [subjectText];
  for (const extra of [game, platform]) {
    const token = String(extra || "").trim();
    if (token && !subjectPadded.includes(` ${token.toLowerCase()} `)) parts.push(token);
  }
  return sanitizeVisualSearchQuery(parts.filter(Boolean).join(" "));
}

/**
 * @param {string} host
 */
function hostBlocked(host) {
  const lower = host.toLowerCase();
  return IMAGE_BLOCK_HOSTS.some((blocked) => lower.includes(blocked));
}

/**
 * @param {string} host
 */
function hostPreferred(host) {
  const lower = host.toLowerCase();
  return PREFERRED_IMAGE_HOSTS.some((preferred) => lower.includes(preferred));
}

/**
 * @param {string} text
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

/** @param {string} text */
function topicTokenize(text) {
  return tokenize(text).filter((token) => !TOPIC_STOPWORDS.has(token));
}

/**
 * Rank Serper image hits for a game-item lookup, best first.
 *
 * @param {SerperImageHit[]} hits
 * @param {{ game?: string; platform?: string; topic?: string }} context
 * @returns {VisualIllustration[]}
 */
export function rankSerperImages(hits, { game = "", platform = "", topic = "" } = {}) {
  if (!Array.isArray(hits) || !hits.length) return [];

  const gameTokens = tokenize(game);
  const platformToks = platformTokens(platform);
  const topicTokens = topicTokenize(topic);
  /** @type {{ score: number; illustration: VisualIllustration }[]} */
  const scored = [];

  for (const hit of hits) {
    const imageUrl = typeof hit.imageUrl === "string" ? hit.imageUrl.trim() : "";
    if (!imageUrl.startsWith("http")) continue;

    let host = "";
    try {
      host = new URL(imageUrl).hostname;
      if (hostBlocked(host)) continue;
    } catch {
      continue;
    }

    const haystack = [hit.title, hit.domain, hit.link, imageUrl]
      .filter((part) => typeof part === "string")
      .join(" ")
      .toLowerCase();

    let topicHits = 0;
    let score = 0;
    for (const token of gameTokens) {
      if (haystack.includes(token)) score += 1;
    }
    for (const token of topicTokens) {
      if (haystack.includes(token)) {
        score += 4;
        topicHits += 1;
      }
    }
    for (const token of platformToks) {
      if (haystack.includes(token)) score += 2;
      else if (/\b(switch|ps4|ps5|xbox|steam)\b/i.test(haystack)) score -= 3;
    }
    if (/\bgame\s*boy\b/i.test(platform)) {
      if (/\b(switch|lans|nintendo\s*switch)\b/i.test(haystack)) score -= 8;
      if (/\b(gbc|game\s*boy)\b/i.test(haystack)) score += 3;
    }
    // Game title alone must not beat a real subject hit (trace 0fc23cf9: GameStop cover).
    if (topicTokens.length > 0 && topicHits === 0) continue;

    if (hostPreferred(host)) score += 4;
    if (/\b(icon|sprite|item|inventory|wiki|model|render)\b/i.test(haystack)) score += 2;
    if (GUIDE_ARTICLE_HINTS.test(haystack)) score -= 6;
    if (COVER_ART_HINTS.test(haystack)) score -= 10;

    if (topicTokens.length > 0 && score < 4) continue;

    const alt =
      typeof hit.title === "string" && hit.title.trim()
        ? hit.title.trim().slice(0, 120)
        : "Reference image";
    const sourceUrl =
      typeof hit.link === "string" && hit.link.startsWith("http") ? hit.link : undefined;
    scored.push({
      score,
      illustration: { url: imageUrl, alt, ...(sourceUrl ? { sourceUrl } : {}) },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.illustration);
}

/**
 * Pick the best Serper image hit for a game-item lookup.
 *
 * @param {SerperImageHit[]} hits
 * @param {{ game?: string; platform?: string; topic?: string }} context
 * @returns {VisualIllustration | null}
 */
export function pickBestSerperImage(hits, context) {
  return rankSerperImages(hits, context)[0] ?? null;
}

/**
 * Does a plain fetch actually get an image back from this URL?
 *
 * The browser hides a broken `<img>`, so shipping an unloadable pick looks
 * identical to finding no image at all (trace c36cf856: a Cloudflare-challenged
 * wiki host answered 403 HTML). Body is cancelled once the headers arrive, so
 * this costs headers, not the whole image.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function probeImageUrl(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "GameGuideGo/1.0", Accept: "image/*" },
      signal: AbortSignal.timeout(6_000),
      redirect: "follow",
    });
    const loadable =
      response.ok && (response.headers.get("content-type") || "").startsWith("image/");
    void response.body?.cancel().catch(() => {});
    return loadable;
  } catch {
    return false;
  }
}

/**
 * First candidate that actually loads, in rank order. Probes run in parallel so
 * the whole check costs one timeout, and it overlaps answer generation anyway.
 *
 * @param {VisualIllustration[]} ranked
 * @param {{ probe?: (url: string) => Promise<boolean>; limit?: number }} [options]
 * @returns {Promise<VisualIllustration | null>}
 */
export async function pickLoadableIllustration(ranked, { probe = probeImageUrl, limit = 3 } = {}) {
  const candidates = ranked.slice(0, limit);
  const loadable = await Promise.all(candidates.map((candidate) => probe(candidate.url)));
  return candidates[loadable.indexOf(true)] ?? null;
}
