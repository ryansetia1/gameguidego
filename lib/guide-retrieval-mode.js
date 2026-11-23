import { normGameKey } from "./game-room.js";

/** @typedef {"default" | "skip" | "supplement" | "knowledge"} GuideRetrievalMode */

export const GUIDE_RETRIEVAL_STORAGE_KEY = "gg:guide-retrieval-mode-by-game";

/** @param {unknown} value @returns {GuideRetrievalMode} */
export function coerceGuideRetrievalMode(value) {
  if (value === "skip" || value === "supplement" || value === "knowledge") return value;
  return "default";
}

/**
 * Trust-boundary flags for POST /api/solve.
 * @param {unknown} record
 */
export function coerceGuideRetrievalFlags(record) {
  const body = record && typeof record === "object" ? record : {};
  const skipPreferredGuide = Boolean(
    /** @type {{ skipPreferredGuide?: unknown }} */ (body).skipPreferredGuide,
  );
  const alsoSearchWeb =
    Boolean(/** @type {{ alsoSearchWeb?: unknown }} */ (body).alsoSearchWeb) &&
    !skipPreferredGuide;
  // Knowledge only implies skipping the guide too (no guide, no web).
  const knowledgeOnly = Boolean(/** @type {{ knowledgeOnly?: unknown }} */ (body).knowledgeOnly);
  return {
    skipPreferredGuide: skipPreferredGuide || knowledgeOnly,
    alsoSearchWeb: alsoSearchWeb && !knowledgeOnly,
    knowledgeOnly,
  };
}

/** @param {GuideRetrievalMode} mode */
export function guideRetrievalModeToApi(mode) {
  const coerced = coerceGuideRetrievalMode(mode);
  return {
    skipPreferredGuide: coerced === "skip" || coerced === "knowledge",
    alsoSearchWeb: coerced === "supplement",
    knowledgeOnly: coerced === "knowledge",
  };
}

/** @param {GuideRetrievalMode} current @param {"skip" | "supplement" | "knowledge"} target */
export function toggleGuideRetrievalMode(current, target) {
  const mode = coerceGuideRetrievalMode(current);
  return mode === target ? "default" : target;
}

/** @returns {Record<string, GuideRetrievalMode>} */
function readModeMap() {
  const raw = JSON.parse(localStorage.getItem(GUIDE_RETRIEVAL_STORAGE_KEY) || "{}");
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/**
 * Per-game mode from localStorage (keyed by `normGameKey`). Fails open to "default".
 * @param {string} game
 * @returns {GuideRetrievalMode}
 */
export function loadGuideRetrievalMode(game) {
  const key = normGameKey(game);
  if (!key || typeof localStorage === "undefined") return "default";
  try {
    return coerceGuideRetrievalMode(readModeMap()[key]);
  } catch {
    return "default";
  }
}

/** @param {string} game @param {GuideRetrievalMode} mode */
export function saveGuideRetrievalMode(game, mode) {
  const key = normGameKey(game);
  if (!key || typeof localStorage === "undefined") return;
  try {
    const all = readModeMap();
    const coerced = coerceGuideRetrievalMode(mode);
    if (coerced === "default") delete all[key];
    else all[key] = coerced;
    localStorage.setItem(GUIDE_RETRIEVAL_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // private browsing / quota: fail open to default
  }
}
