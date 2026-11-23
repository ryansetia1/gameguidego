/** @typedef {"default" | "skip" | "supplement" | "knowledge"} GuideRetrievalMode */

export const GUIDE_RETRIEVAL_STORAGE_KEY = "gg:guide-retrieval-mode";

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

/** @returns {GuideRetrievalMode} */
export function loadGuideRetrievalMode() {
  if (typeof sessionStorage === "undefined") return "default";
  try {
    return coerceGuideRetrievalMode(sessionStorage.getItem(GUIDE_RETRIEVAL_STORAGE_KEY));
  } catch {
    return "default";
  }
}

/** @param {GuideRetrievalMode} mode */
export function saveGuideRetrievalMode(mode) {
  if (typeof sessionStorage === "undefined") return;
  try {
    const coerced = coerceGuideRetrievalMode(mode);
    if (coerced === "default") sessionStorage.removeItem(GUIDE_RETRIEVAL_STORAGE_KEY);
    else sessionStorage.setItem(GUIDE_RETRIEVAL_STORAGE_KEY, coerced);
  } catch {
    // private browsing / quota — fail open to default
  }
}
