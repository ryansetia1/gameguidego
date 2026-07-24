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
