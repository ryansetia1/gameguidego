export const TOPIC_VISUAL_SEARCH_KEY = "gg:topic-visual-search";
export const VISUAL_SEARCH_TOGGLE_LABEL = "Reference images";
export const VISUAL_SEARCH_TOGGLE_HINT =
  "Look up a reference image when you ask what something looks like.";

/** @param {unknown} value @returns {boolean} */
export function coerceVisualSearchEnabled(value) {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === 1 || value === "true") return true;
  return false;
}

/**
 * Per-topic visual search toggle. Default off.
 * @param {{ id?: string; visual_search?: boolean } | null | undefined} chat
 * @returns {boolean}
 */
export function loadTopicVisualSearchPrefs(chat) {
  if (chat && typeof chat.visual_search === "boolean") {
    return chat.visual_search;
  }
  if (chat?.id) {
    const stored = loadTopicVisualSearchById(chat.id);
    if (stored !== null) return stored;
  }
  return false;
}

/** @param {string} chatId @returns {boolean | null} */
export function loadTopicVisualSearchById(chatId) {
  if (!chatId || typeof window === "undefined") return null;
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_VISUAL_SEARCH_KEY) || "{}");
    const value = all[chatId];
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** @param {string} chatId @param {boolean} enabled */
export function saveTopicVisualSearchById(chatId, enabled) {
  if (!chatId || typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_VISUAL_SEARCH_KEY) || "{}");
    if (enabled) all[chatId] = true;
    else delete all[chatId];
    window.localStorage.setItem(TOPIC_VISUAL_SEARCH_KEY, JSON.stringify(all));
  } catch {
    // private mode
  }
}

/** @param {boolean} enabled */
export function topicVisualSearchPayload(enabled) {
  return { visual_search: Boolean(enabled) };
}
