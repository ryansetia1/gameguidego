/**
 * User-facing copy when preferred-guide indexing fails or the URL looks like a hub.
 * @param {{
 *   available?: boolean;
 *   indexed?: boolean;
 *   hubWarning?: boolean;
 *   indexedCount?: number;
 *   total?: number;
 * }} input
 * @returns {string | null}
 */
export function guideIngestHint(input = {}) {
  // Callers gate this on "nothing indexed" (see solve/route.ts); a bare
  // hubWarning still means the paste was an index page.
  if (input.hubWarning) {
    return "That link looks like an index page. Paste the page with the full walkthrough.";
  }
  if (input.available === false) return null;

  const total = input.total ?? 1;
  const indexedCount =
    input.indexedCount ?? (input.indexed === false ? 0 : total);
  const failed = total - indexedCount;

  if (failed <= 0) return null;
  if (indexedCount === 0) {
    return total === 1
      ? "Couldn't read that guide. Try a different link or source."
      : "Couldn't read your guides. Try a different link or source.";
  }
  // Don't claim web search ran — on a high-similarity RAG hit it's skipped.
  return `Couldn't read ${failed} of ${total} guides. Answering from what we read.`;
}

/** Toast when an indexed guide was searched but missed; answer came from web. */
export function guideSearchFallbackHint() {
  return "Couldn't find that in your guide. Answered from web search.";
}

/** Toast when the player skipped their guide and used web search instead. */
export function guideSkippedForWebHint() {
  return "Skipped your guide and searched the web.";
}

/** Toast when guide hit and the player also asked for web search. */
export function guideWebSupplementHint() {
  return "Also checked the web.";
}

/** No preferred guides: web search returned nothing; model answers from knowledge. */
export const WEB_KNOWLEDGE_FALLBACK_HINT =
  "Couldn't find on the web, answering from knowledge";

/** Preferred guides indexed but miss on guide and web; model answers from knowledge. */
export const GUIDE_WEB_KNOWLEDGE_FALLBACK_HINT =
  "Couldn't find that in your guide or on the web. Answering from knowledge.";

/**
 * True when copy only makes sense if the user attached preferred guides.
 * @param {string} hint
 */
export function isPreferredGuideHint(hint) {
  if (!hint) return false;
  if (hint.includes("in your guide")) return true;
  if (hint.startsWith("Couldn't read")) return true;
  if (/index page/i.test(hint)) return true;
  return false;
}

/**
 * Post-turn toast after /api/solve.
 * @param {{
 *   pipelineType?: string;
 *   preferredUrls?: string[];
 *   guideHint?: string;
 *   ingestHint?: string | null;
 * }} input
 * @returns {string | undefined}
 */
export function solveTurnToast(input = {}) {
  const { pipelineType, guideHint, ingestHint } = input;
  const preferredUrls = Array.isArray(input.preferredUrls) ? input.preferredUrls : [];
  const hasPreferred = preferredUrls.length > 0;

  if (pipelineType === "web") return undefined;

  if (pipelineType === "web_skip_guide") {
    if (!hasPreferred) return undefined;
    return guideHint || guideSkippedForWebHint();
  }

  if (pipelineType === "rag_supplemented") {
    if (!hasPreferred) return undefined;
    return guideHint || guideWebSupplementHint();
  }

  if (pipelineType === "fallback_web") {
    if (!hasPreferred) return undefined;
    return guideHint || guideSearchFallbackHint();
  }

  if (!guideHint || guideHint === ingestHint) return undefined;
  if (!hasPreferred && isPreferredGuideHint(guideHint)) return undefined;
  return guideHint;
}

/**
 * Parse a batch ingest API response into toast copy.
 * @param {unknown} payload
 * @returns {string | null}
 */
export function guideIngestHintFromResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const results = Array.isArray(record.results) ? record.results : [];

  const total =
    typeof record.total === "number"
      ? record.total
      : results.length || (record.indexed === false ? 1 : 0);
  const indexedCount =
    typeof record.indexedCount === "number"
      ? record.indexedCount
      : results.filter((row) => row && typeof row === "object" && row.indexed).length;
  return guideIngestHint({
    available: record.available !== false,
    hubWarning: Boolean(record.hubWarning),
    indexedCount,
    total: total || undefined,
  });
}
