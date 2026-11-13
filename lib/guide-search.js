/** @type {Set<string>} */
const DISCOVERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
]);

/**
 * Build a web search query for browsing walkthrough pages in the setup UI.
 * Multi-word titles are quoted so providers treat them as a phrase.
 * @param {string} game
 * @param {string} platform
 * @param {string} [query]
 */
export function buildGuideDiscoveryQuery(game, platform, query = "") {
  const name = game.trim();
  const extra = query.trim() || "walkthrough guide";
  const quoted =
    name.includes(" ") ? `"${name.replace(/"/g, "")}"` : name;
  return [quoted, platform.trim(), extra]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Significant title tokens for relevance checks (drops "the", etc.).
 * @param {string} game
 * @returns {string[]}
 */
export function guideDiscoveryTokens(game) {
  return game
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => {
      if (!word) return false;
      if (/^\d+$/.test(word)) return true;
      return word.length > 1 && !DISCOVERY_STOP_WORDS.has(word);
    });
}

/**
 * True when a search hit title plausibly belongs to the requested game.
 * @param {string} game
 * @param {string} title
 */
export function guideDiscoveryMatchesGame(game, title) {
  const name = game.trim().toLowerCase();
  const hit = title.toLowerCase();
  if (!name) return true;
  if (hit.includes(name)) return true;

  const tokens = guideDiscoveryTokens(game);
  if (!tokens.length) return true;
  return tokens.every((token) => hit.includes(token));
}

/**
 * Keep only title-relevant guide hits; answer-time search is unaffected.
 * @template {{ title: string }} T
 * @param {string} game
 * @param {T[]} results
 * @returns {T[]}
 */
export function filterGuideDiscoveryResults(game, results) {
  if (!game.trim()) return results;
  return results.filter((row) => guideDiscoveryMatchesGame(game, row.title));
}

// Filler the answer-time query rewrite tends to add, including the request
// phrasing ("Please provide instructions on...") it sometimes emits. English
// only because the rewrite always outputs English; other words pass through.
/** @type {Set<string>} */
const WEB_QUERY_FILLER = new Set([
  ...DISCOVERY_STOP_WORDS,
  "about", "after", "am", "any", "are", "be", "by", "can", "could", "describe",
  "detail", "details", "do", "does", "explain", "find", "from", "get", "guide",
  "how", "i", "include", "including", "information", "instructions", "is", "it",
  "its", "looking", "me", "my", "need", "or", "please", "provide", "should",
  "specific", "steps", "that", "this", "what", "when", "where", "which", "while",
  "who", "why", "with", "walkthrough", "would", "you",
  // Prepositions, auxiliaries and pronouns: grammar even when capitalised.
  "also", "around", "before", "been", "between", "but", "during", "has", "have",
  "here", "if", "into", "near", "not", "over", "so", "stuck", "than", "their",
  "them", "then", "there", "they", "through", "under", "until", "was", "were",
  "without",
]);
const WEB_QUERY_MAX_KEYWORDS = 8;

/**
 * Answer-time web query: game + platform + up to 8 core keywords from the
 * rewritten topic + "walkthrough guide". Long sentence-like topics drag Tavily
 * scores under the confidence gate, so filler and words already in the
 * game/platform prefix are dropped. Mid-sentence capitalised words (proper
 * nouns) and numbers win when the cap bites; output keeps the topic's order.
 * @param {string} game
 * @param {string} platform
 * @param {string} searchTopic
 */
export function buildWebSearchQuery(game, platform, searchTopic) {
  const prefix = [game, platform].map((part) => part.trim()).filter(Boolean);
  const taken = new Set(
    prefix.join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  );
  /** @type {{ word: string, strong: boolean }[]} */
  const words = [];
  for (const sentence of searchTopic.split(/(?<=[.!?])\s+|\n+/u)) {
    let first = true;
    for (const raw of sentence.split(/[^\p{L}\p{N}'’-]+/u)) {
      const word = raw.replace(/^['’-]+|['’-]+$/gu, "");
      if (!word) continue;
      // A capital at a sentence start is grammar, not evidence of a name.
      const strong = /^\p{N}/u.test(word) || (!first && /^\p{Lu}/u.test(word));
      first = false;
      const key = word.toLowerCase();
      if (taken.has(key) || WEB_QUERY_FILLER.has(key)) continue;
      taken.add(key);
      words.push({ word, strong });
    }
  }
  let keep = words;
  if (words.length > WEB_QUERY_MAX_KEYWORDS) {
    const strong = new Set(words.filter((w) => w.strong).slice(0, WEB_QUERY_MAX_KEYWORDS));
    const weak = new Set(
      words.filter((w) => !w.strong).slice(0, WEB_QUERY_MAX_KEYWORDS - strong.size),
    );
    keep = words.filter((w) => strong.has(w) || weak.has(w));
  }
  return [...prefix, ...keep.map((w) => w.word), "walkthrough guide"].join(" ");
}
