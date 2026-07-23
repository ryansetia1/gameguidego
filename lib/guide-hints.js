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

/**
 * Parse a batch ingest API response into toast copy.
 * @param {unknown} payload
 * @returns {string | null}
 */
export function guideIngestHintFromResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const results = Array.isArray(record.results) ? record.results : [];

  for (const row of results) {
    if (!row || typeof row !== "object") continue;
    const bundle = /** @type {Record<string, unknown>} */ (row);
    if (!bundle.bundle) continue;
    const pageCount = typeof bundle.pageCount === "number" ? bundle.pageCount : 0;
    const pagesIndexed =
      typeof bundle.pagesIndexed === "number" ? bundle.pagesIndexed : pageCount;
    if (pageCount > 0 && pagesIndexed < pageCount) {
      const missingPages = Array.isArray(bundle.pagesMissing)
        ? bundle.pagesMissing.filter(
            (page) =>
              page &&
              typeof page === "object" &&
              typeof page.title === "string" &&
              page.title.trim(),
          )
        : [];
      const missing = pageCount - pagesIndexed;
      if (missingPages.length) {
        const names = missingPages
          .slice(0, 3)
          .map((page) => page.title.trim())
          .join(", ");
        const more =
          missingPages.length > 3 ? ` +${missingPages.length - 3} more` : "";
        return `Indexed ${pagesIndexed} of ${pageCount} bundle pages. Not indexed: ${names}${more}.`;
      }
      return `Indexed ${pagesIndexed} of ${pageCount} bundle pages. ${missing} section${missing > 1 ? "s" : ""} skipped; answers may use web search for those.`;
    }
  }

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
