import { WRITING_ANSWER_PLACEHOLDER } from "./chat-messages.js";

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

/**
 * True when the stored title is empty or still the Phase A truncate of the first question.
 * @param {string} [existingTitle]
 * @param {unknown} [messages]
 */
export function isAutoDerivedTopicTitle(existingTitle, messages = []) {
  const current = String(existingTitle ?? "").trim();
  if (!current) return true;
  const auto = titleFromMessages(messages);
  return !auto || current === auto;
}

/**
 * First-turn topic title: hold a skeleton until the answer (and LLM title) land.
 *
 * @param {{ messages?: unknown; loading?: boolean; title?: string }} input
 */
export function shouldShowTopicTitleSkeleton({ messages, loading = false, title = "" }) {
  if (!Array.isArray(messages)) return false;
  const userCount = messages.filter(
    (row) => row && typeof row === "object" && row.role === "user",
  ).length;
  if (userCount !== 1) return false;
  if (!isAutoDerivedTopicTitle(title, messages)) return false;
  const assistant = messages.find(
    (row) => row && typeof row === "object" && row.role === "assistant",
  );
  const answerPending =
    loading ||
    !assistant ||
    assistant.content === WRITING_ANSWER_PLACEHOLDER ||
    !String(assistant.content || "").trim();
  return answerPending;
}

/**
 * Title to persist or emit. User renames win; LLM title only replaces auto-derived titles.
 *
 * @param {string} [existingTitle]
 * @param {unknown} [messages]
 * @param {string} [generatedTitle]
 * @returns {string}
 */
export function topicTitleForPersist(existingTitle, messages = [], generatedTitle = "") {
  const existing = String(existingTitle ?? "").trim();
  const generated = String(generatedTitle ?? "").trim();

  if (existing && !isAutoDerivedTopicTitle(existing, messages)) {
    return existing;
  }
  if (generated) return generated;
  return titleFromMessages(messages);
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function parseGeneratedTopicTitle(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  let jsonText = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) jsonText = fenced[1].trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start === -1 || end <= start) return truncateTitle(text, 60);
  try {
    const parsed = JSON.parse(jsonText.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return "";
    const title =
      "title" in parsed && typeof parsed.title === "string"
        ? parsed.title.replace(/\s+/g, " ").trim()
        : "";
    return truncateTitle(title, 60);
  } catch {
    return "";
  }
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
