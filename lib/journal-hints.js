export const JOURNAL_TOAST_FALLBACK = "Progress saved to your journal.";
export const JOURNAL_STARTED_TOAST = "Journal started for this game.";

/**
 * @param {{ summary?: string, trigger?: string, bodyCharsBefore?: number }} input
 * @returns {string}
 */
export function journalUpdateToast(input = {}) {
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (summary) return summary;
  if (input.trigger === "auto" && (input.bodyCharsBefore ?? 0) === 0) {
    return JOURNAL_STARTED_TOAST;
  }
  return JOURNAL_TOAST_FALLBACK;
}
