/** @typedef {{ title: string; imageUrl: string; link?: string; domain?: string }} SerperImageHit */
/** @typedef {{ url: string; alt: string; sourceUrl?: string }} VisualIllustration */

const VISUAL_INTENT_EN =
  /\b(looks?\s+like|what\s+does\s+.+\s+look|what\s+do\s+.+\s+look|appearance|screenshot|icon(?:\s+of)?|sprite|portrait|inventory\s+icon)\b/i;

const VISUAL_INTENT_ID =
  /(kaya\s+gimana|kayak\s+gimana|kya\s+gimana|gimana\s+(?:bentuk|tampilan|wujud)|terlihat\s+seperti|iconnya|gambar(?:nya)?|bentuknya|tampilannya|visualnya)/i;

const IMAGE_BLOCK_HOSTS = [
  "pinterest.",
  "shutterstock.",
  "gettyimages.",
  "istockphoto.",
  "alamy.",
  "dreamstime.",
  "depositphotos.",
  "vectorstock.",
];

const PREFERRED_IMAGE_HOSTS = [
  "fandom.com",
  "wikia.com",
  "game8.co",
  "ign.com",
  "gamespot.com",
  "strategywiki.org",
  "neoseeker.com",
  "nintendo.com",
  "steamstatic.com",
];

/**
 * True when the player is asking what something looks like (not where/how to get it).
 * ponytail: EN/ID regex only — follow-ups without a subject ("gimana bentuknya?") and
 * incidental "icon" in non-visual questions can false-positive; upgrade path: gate on
 * rewrite/searchTopic or add history-aware intent.
 *
 * @param {string} question
 */
export function isVisualLookupQuestion(question) {
  const text = question.replace(/\s+/g, " ").trim();
  if (!text) return false;
  return VISUAL_INTENT_EN.test(text) || VISUAL_INTENT_ID.test(text);
}

/**
 * @param {string} game
 * @param {string} platform
 * @param {string} searchTopic
 */
export function buildVisualSearchQuery(game, platform, searchTopic) {
  return [game, platform, searchTopic, "item icon"]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * Pick the best Serper image hit for a game-item lookup.
 *
 * @param {SerperImageHit[]} hits
 * @param {{ game?: string; topic?: string }} context
 * @returns {VisualIllustration | null}
 */
export function pickBestSerperImage(hits, { game = "", topic = "" } = {}) {
  if (!Array.isArray(hits) || !hits.length) return null;

  const gameTokens = tokenize(game);
  const topicTokens = tokenize(topic);
  let best = null;
  let bestScore = -1;

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

    let score = 0;
    for (const token of gameTokens) {
      if (haystack.includes(token)) score += 2;
    }
    for (const token of topicTokens) {
      if (haystack.includes(token)) score += 3;
    }
    if (hostPreferred(host)) score += 4;
    if (/\b(icon|sprite|item|inventory)\b/i.test(haystack)) score += 2;

    if (score > bestScore) {
      bestScore = score;
      const alt =
        typeof hit.title === "string" && hit.title.trim()
          ? hit.title.trim().slice(0, 120)
          : "Reference image";
      const sourceUrl =
        typeof hit.link === "string" && hit.link.startsWith("http") ? hit.link : undefined;
      best = { url: imageUrl, alt, ...(sourceUrl ? { sourceUrl } : {}) };
    }
  }

  // ponytail: require at least one topic token match when we have a topic, else
  // random Google Images noise slips through on generic queries.
  if (best && topicTokens.length > 0 && bestScore < 3) return null;
  return best;
}
