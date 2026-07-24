export const TOPIC_TITLE_BY_ID_KEY = "gg:topic-title";

/** @param {string} chatId @returns {string | null} */
export function loadTopicTitleById(chatId) {
  if (!chatId || typeof window === "undefined") return null;
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_TITLE_BY_ID_KEY) || "{}");
    const value = all[chatId];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** @param {string} chatId @param {string} title */
export function saveTopicTitleById(chatId, title) {
  if (!chatId || typeof window === "undefined") return;
  const trimmed = String(title || "").trim().slice(0, 120);
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_TITLE_BY_ID_KEY) || "{}");
    if (trimmed) all[chatId] = trimmed;
    else delete all[chatId];
    window.localStorage.setItem(TOPIC_TITLE_BY_ID_KEY, JSON.stringify(all));
  } catch {
    // private mode
  }
}

/**
 * Row title, then pre-migration localStorage, then first user message.
 * @param {{ id?: string; title?: string; messages?: unknown }} chat
 * @returns {string}
 */
export function resolvedTopicTitle(chat) {
  const row = String(chat.title ?? "").trim();
  if (row) return row;
  if (chat.id) {
    const stored = loadTopicTitleById(chat.id);
    if (stored) return stored;
  }
  return titleFromMessages(chat.messages);
}

/** @param {string} text @param {number} [max] */
export function truncateTitle(text, max = 60) {
  const trimmed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** @param {string} [title] @param {string} [fallback] */
export function displayTopicTitle(title, fallback = "Untitled topic") {
  const value = String(title || "").trim();
  return value || fallback;
}

/**
 * @param {unknown} messages
 * @returns {string}
 */
export function titleFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  for (const row of messages) {
    if (!row || typeof row !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    if (record.role !== "user") continue;
    if (typeof record.content === "string" && record.content.trim()) {
      return truncateTitle(record.content);
    }
  }
  return "";
}

/** @param {unknown} messages @returns {string} */
export function topicPreviewFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row || typeof row !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    if (record.role !== "user") continue;
    if (typeof record.content === "string" && record.content.trim()) {
      return truncateTitle(record.content, 72);
    }
  }
  return "";
}
