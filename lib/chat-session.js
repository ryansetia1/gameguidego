/**
 * Restore the active game chat after a full page reload.
 * Saved chats (signed-in) use a `?chat=<uuid>` query param; anonymous or
 * not-yet-saved threads fall back to a sessionStorage draft.
 */

import { guideUrlsFromDraft } from "./guide-urls.js";

export const CHAT_QUERY_PARAM = "chat";
export const SESSION_DRAFT_KEY = "gg:session";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} value */
export function isChatId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * @param {string} [href]
 * @returns {string | null}
 */
export function getChatIdFromUrl(href) {
  if (typeof window === "undefined" && !href) return null;
  try {
    const url = new URL(href || window.location.href);
    const id = url.searchParams.get(CHAT_QUERY_PARAM);
    return isChatId(id) ? id : null;
  } catch {
    return null;
  }
}

/** @param {string | null | undefined} id */
export function setChatUrl(id) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id && isChatId(id)) url.searchParams.set(CHAT_QUERY_PARAM, id);
  else url.searchParams.delete(CHAT_QUERY_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

/**
 * @param {unknown} value
 * @returns {{ game: string; platform: string; preferredUrls: string[]; cover: string; releaseYear: string; activeChatId: string | null; messages: unknown[]; gameView: "topics" | "thread" } | null}
 */
export function coerceSessionDraft(value) {
  if (!value || typeof value !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (value);
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const game = typeof o.game === "string" ? o.game.slice(0, 120) : "";
  if (!game.trim()) return null;
  const gameView = o.gameView === "topics" ? "topics" : "thread";
  if (!messages.length && gameView !== "topics") return null;
  const rawId = o.activeChatId;
  const activeChatId = isChatId(rawId) ? /** @type {string} */ (rawId) : null;
  return {
    game,
    platform: typeof o.platform === "string" ? o.platform.slice(0, 80) : "",
    preferredUrls: guideUrlsFromDraft(o),
    cover: typeof o.cover === "string" && !o.cover.startsWith("blob:") ? o.cover.slice(0, 2048) : "",
    releaseYear: typeof o.releaseYear === "string" ? o.releaseYear.slice(0, 8) : "",
    activeChatId,
    messages: messages.slice(0, 40),
    gameView,
  };
}

/** @returns {ReturnType<typeof coerceSessionDraft>} */
export function loadSessionDraft() {
  if (typeof window === "undefined") return null;
  try {
    return coerceSessionDraft(JSON.parse(window.sessionStorage.getItem(SESSION_DRAFT_KEY) || "null"));
  } catch {
    return null;
  }
}

/** @param {NonNullable<ReturnType<typeof coerceSessionDraft>>} draft */
export function saveSessionDraft(draft) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // quota / private mode — best-effort
  }
}

export function clearSessionDraft() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_DRAFT_KEY);
  } catch {
    // ignore
  }
}
