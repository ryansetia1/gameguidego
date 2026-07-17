/**
 * @typedef {{ title: string, url: string, content: string, score: number }} Ranked
 */

// Keep only the few strongest matches.
const MAX_RESULTS = 3;
// Results within this window below the top score are kept; the rest (usually
// same-series wrong-game guides) are dropped.
const SCORE_WINDOW = 0.1;
// A hard floor so individual weak results never ride in on a strong top score.
const ABS_MIN_SCORE = 0.4;
// Confidence gate: if even the best match is weaker than this, return nothing so
// the model answers from its own knowledge instead of being nudged by a
// marginally-relevant snippet. Calibrated on Tavily "advanced" scores, where
// on-topic guides land ~0.65+; tune here if answers cite too much/too little.
const CONFIDENCE_MIN = 0.5;

/**
 * Gate on confidence, then keep the strongest few deduped results.
 * Returns [] when no result is clearly relevant.
 *
 * @param {Ranked[]} results
 * @returns {Ranked[]}
 */
export function selectSources(results) {
  if (!Array.isArray(results) || results.length === 0) return [];

  const topScore = Math.max(...results.map((result) => result.score));
  if (topScore < CONFIDENCE_MIN) return [];

  const floor = Math.max(topScore - SCORE_WINDOW, ABS_MIN_SCORE);

  return results
    .filter((result) => result.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
}
