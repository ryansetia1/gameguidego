/** @typedef {{ title: string; imageUrl: string; link?: string; domain?: string }} SerperImageHit */
/** @typedef {{ url: string; alt: string; sourceUrl?: string }} VisualIllustration */

const VISUAL_INTENT_EN =
  /\b(looks?\s+like|what\s+does\s+.+\s+look|what\s+do\s+.+\s+look|appearance|screenshot|icon(?:\s+of)?|sprite|portrait|inventory\s+icon)\b/i;

const VISUAL_INTENT_ID =
  /(?:kaya\s+gimana|kayak\s+gimana|kya\s+gimana|seperti\s+apa|terlihat\s+seperti|gimana\s+(?:bentuk|tampilan|wujud|rupa|penampilan)(?:nya)?|(?:bentuk|tampilan|wujud|rupa|penampilan|penampakan)(?:nya)?\s+(?:gimana|kaya|kayak)|iconnya|gambar(?:nya)?|visualnya|ada\s+gambarnya|punya\s+gambarnya)/i;

const VISUAL_NOUN_ID =
  /\b(wujud(?:nya)?|bentuk(?:nya)?|tampilan(?:nya)?|penampilan(?:nya)?|rupa(?:nya)?|penampakan(?:nya)?)\b/i;

const VISUAL_ASK_ID =
  /\b(gimana|seperti\s+apa|kaya\s+gimana|kayak\s+gimana|terlihat|looks?)\b/i;

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

const VISUAL_SUBJECT_ID_NOISE =
  /\b(bentuknya|tampilannya|wujudnya|gambar(?:nya)?|iconnya|kaya\s+gimana|kayak\s+gimana|kya\s+gimana|gimana\s+(?:bentuk|tampilan|wujud)|terlihat\s+seperti|visualnya|seperti\s+apa|gimana\s+sih|ada\s+gambarnya|punya\s+gambarnya)\b/gi;

const VISUAL_SUBJECT_ID_PARTICLES =
  /\b(itu|sih|ya|dong|nih|deh|kan|kmu|kamu|ga|gak|nggak|ngak|ada|gambarnya|punya)\b/gi;

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

const VISUAL_SUBJECT_EN_NOISE =
  /\b(what\s+does|what\s+do|look\s+like|looks\s+like|appearance\s+of|how\s+does\s+.+\s+look|icon\s+of|sprite\s+of)\b/gi;

/** @param {string} text */
function hasIndonesianVisualIntent(text) {
  if (VISUAL_INTENT_ID.test(text)) return true;
  if (VISUAL_NOUN_ID.test(text) && VISUAL_ASK_ID.test(text)) return true;
  return false;
}

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
  return VISUAL_INTENT_EN.test(text) || hasIndonesianVisualIntent(text);
}

/**
 * Short item/subject label for image search. RAG rewrites are multi-sentence
 * paragraphs — never pass those straight to Serper (trace ea24ff34).
 *
 * @param {string} question
 * @param {string} [searchTopic]
 */
export function extractVisualSubject(question, searchTopic = "") {
  const q = String(question || "").replace(/\s+/g, " ").trim();
  const topic = String(searchTopic || "").replace(/\s+/g, " ").trim();

  const ragLead = topic.match(
    /describe\s+the\s+(?:visual\s+)?appearance\s+of\s+(?:the\s+)?(?:(?:guardian\s+force|summon|boss|character|enemy|item)\s+)?(.+?)(?:\s+item)?\./i,
  );
  if (ragLead?.[1]) {
    const name = ragLead[1]
      .replace(/\b(the|item|sprite|icon)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length >= 2 && name.length <= 60) return name;
  }

  if (
    topic &&
    topic.length <= 80 &&
    !/\.\s+[A-Z]/.test(topic) &&
    topic.split(/\s+/).length <= 15
  ) {
    const short = topic.replace(/\b(icon|sprite|item)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (short.length >= 2) return short;
  }

  const fromQ = q
    .replace(VISUAL_SUBJECT_ID_NOISE, " ")
    .replace(VISUAL_SUBJECT_ID_PARTICLES, " ")
    .replace(VISUAL_SUBJECT_EN_NOISE, " ")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (fromQ.length >= 2 && fromQ.length <= 60) return fromQ;

  const first = topic.split(/[.!?]/)[0]?.trim() || "";
  if (first.length >= 2) {
    const stripped = first
      .replace(/^(?:describe|explain)\s+(?:the\s+)?/i, "")
      .replace(/\b(appearance|look)\s+of\s+(?:the\s+)?/i, "")
      .replace(/\s+item$/i, "")
      .trim();
    if (stripped.length >= 2) return stripped.slice(0, 60);
  }

  return fromQ || q.slice(0, 60) || topic.slice(0, 60);
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
  return sanitizeVisualSearchQuery(
    [subject, game, platform].filter(Boolean).join(" "),
  );
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
 * Pick the best Serper image hit for a game-item lookup.
 *
 * @param {SerperImageHit[]} hits
 * @param {{ game?: string; platform?: string; topic?: string }} context
 * @returns {VisualIllustration | null}
 */
export function pickBestSerperImage(hits, { game = "", platform = "", topic = "" } = {}) {
  if (!Array.isArray(hits) || !hits.length) return null;

  const gameTokens = tokenize(game);
  const platformToks = platformTokens(platform);
  const topicTokens = topicTokenize(topic);
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

  if (best && topicTokens.length > 0 && bestScore < 4) return null;
  return best;
}
