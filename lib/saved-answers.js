/**
 * Saved answers: GameGuideGo replies a player bookmarks per game. The device copy in
 * localStorage is what makes them readable offline; signed-in users also get a
 * Supabase copy (`public.saved_answers`, see db/saved-answers.sql) merged by `mergeRemote`.
 *
 * Each item is a snapshot (question + reply text + highlights + spoilers + own source
 * links), so deleting the chat it came from never breaks it. No third-party page text.
 *
 * Item: { id, owner, gameKey, game, platform, question, content, highlights, spoilers,
 *         sources, createdAt, synced, deleted }
 * - owner: user id, or null for signed-out saves (claimed by the next signed-in sync).
 * - synced: the server has this exact item. deleted: tombstone waiting for a server delete.
 *
 * ponytail: localStorage + caps, not IndexedDB; upgrade if answers grow large.
 */

import { WRITING_ANSWER_PLACEHOLDER } from "./chat-messages.js";
import { normGameKey } from "./game-room.js";
import { coerceHighlights, coerceSpoilers } from "./highlights.js";

export const SAVED_ANSWERS_KEY = "gg:saved-answers";
export const SAVED_ANON_HINT_KEY = "gg:saved-answers-anon-hint";
export const SAVED_PER_GAME_CAP = 20;
export const SAVED_DEVICE_CAP = 200;
const PREVIEW_CHARS = 120;

/**
 * @typedef {{ title: string, url: string }} SavedSource
 * @typedef {{
 *   id: string, owner: string|null, gameKey: string, game: string, platform: string,
 *   question: string, content: string, highlights: any[], spoilers: any[],
 *   sources: SavedSource[], createdAt: string, synced: boolean, deleted: boolean,
 * }} SavedItem
 * @typedef {Record<string, any>} SavedRow
 */

/** @returns {SavedItem[]} every stored item (tombstones included), or [] when unreadable */
export function loadSavedItems() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_ANSWERS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((/** @type {any} */ row) => row && typeof row.id === "string" && typeof row.content === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Throws on quota / private-mode errors so callers can surface "Couldn't save".
 * @param {SavedItem[]} items
 */
export function writeSavedItems(items) {
  window.localStorage.setItem(SAVED_ANSWERS_KEY, JSON.stringify(items));
}

/**
 * Items one viewer sees: their own (or anon) and not tombstoned.
 * @param {SavedItem[]} items @param {string|null} owner @returns {SavedItem[]}
 */
export function visibleItems(items, owner) {
  return items.filter((row) => !row.deleted && (row.owner ?? null) === (owner ?? null));
}

/**
 * Newest-first saved answers for one game.
 * @param {SavedItem[]} items @param {string|null} owner @param {string} game
 */
export function itemsForGame(items, owner, game) {
  const key = normGameKey(game);
  return visibleItems(items, owner)
    .filter((row) => row.gameKey === key)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * The saved item for this reply in this game, if any (matched by reply text).
 * @param {SavedItem[]} items @param {string|null} owner @param {string} game @param {string} content
 */
export function findSaved(items, owner, game, content) {
  const key = normGameKey(game);
  return visibleItems(items, owner).find((row) => row.gameKey === key && row.content === content);
}

/** @param {unknown} sources @returns {SavedSource[]} */
function cleanSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s) => s && typeof s.url === "string")
    .map((s) => ({ title: String(s.title || s.url), url: s.url }));
}

/**
 * Build a snapshot item from a chat reply.
 * @param {{ owner: string|null, game: string, platform?: string, question?: string,
 *   message: { content: string, highlights?: any[], spoilers?: any[], sources?: any[] } }} input
 * @param {Date} [now]
 * @returns {SavedItem}
 */
export function buildSavedItem({ owner, game, platform = "", question = "", message }, now = new Date()) {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${now.getTime()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    owner: owner ?? null,
    gameKey: normGameKey(game),
    game,
    platform,
    question,
    content: message.content,
    highlights: Array.isArray(message.highlights) ? message.highlights : [],
    spoilers: Array.isArray(message.spoilers) ? message.spoilers : [],
    sources: cleanSources(message.sources),
    createdAt: now.toISOString(),
    synced: false,
    deleted: false,
  };
}

/**
 * Add an item if caps allow. Returns { items } or { error: "cap" }.
 * Caps count only what the owner sees, so tombstones never block a save.
 * @param {SavedItem[]} items @param {SavedItem} item
 * @returns {{ items: SavedItem[], error?: undefined } | { error: "cap", items?: undefined }}
 */
export function addItem(items, item) {
  const mine = visibleItems(items, item.owner);
  if (mine.length >= SAVED_DEVICE_CAP) return { error: "cap" };
  if (mine.filter((row) => row.gameKey === item.gameKey).length >= SAVED_PER_GAME_CAP) {
    return { error: "cap" };
  }
  return { items: [item, ...items.filter((row) => row.id !== item.id)] };
}

/**
 * Remove: synced items become tombstones (server delete pending), others just go.
 * @param {SavedItem[]} items @param {string} id @returns {SavedItem[]}
 */
export function removeItem(items, id) {
  return items.flatMap((row) => {
    if (row.id !== id) return [row];
    return row.synced ? [{ ...row, deleted: true }] : [];
  });
}

/**
 * Undo a remove: put the snapshot back and re-push it (the server may already have dropped it).
 * @param {SavedItem[]} items @param {SavedItem} item @returns {SavedItem[]}
 */
export function restoreItem(items, item) {
  return [{ ...item, deleted: false, synced: false }, ...items.filter((row) => row.id !== item.id)];
}

/**
 * Signed-out saves on this device become the signed-in user's on their next sync
 * (the anon toast promises "Sign in to keep it across devices").
 * ponytail: on a shared device the next person to sign in inherits them; upgrade path
 * is a one-time "Keep these N saved answers?" prompt before claiming.
 * @param {SavedItem[]} items @param {string} owner @returns {SavedItem[]}
 */
export function claimAnon(items, owner) {
  // Same caps as a fresh save: anything over them stays a signed-out device copy.
  let mine = visibleItems(items, owner).length;
  /** @type {Map<string, number>} */
  const perGame = new Map();
  for (const row of visibleItems(items, owner)) {
    perGame.set(row.gameKey, (perGame.get(row.gameKey) ?? 0) + 1);
  }
  return items.map((row) => {
    if ((row.owner ?? null) !== null || row.deleted) return row;
    const inGame = perGame.get(row.gameKey) ?? 0;
    if (mine >= SAVED_DEVICE_CAP || inGame >= SAVED_PER_GAME_CAP) return row;
    mine += 1;
    perGame.set(row.gameKey, inGame + 1);
    return { ...row, owner, synced: false };
  });
}

/** @param {SavedItem} item @returns {SavedRow} */
export function toRow(item) {
  return {
    id: item.id,
    user_id: item.owner,
    game_key: item.gameKey,
    game: item.game,
    platform: item.platform,
    question: item.question,
    content: item.content,
    highlights: item.highlights,
    spoilers: item.spoilers,
    sources: item.sources,
    created_at: item.createdAt,
  };
}

/** @param {SavedRow} row @returns {SavedItem} */
export function fromRow(row) {
  return {
    id: row.id,
    owner: row.user_id,
    gameKey: row.game_key,
    game: row.game ?? "",
    platform: row.platform ?? "",
    question: row.question ?? "",
    content: row.content ?? "",
    highlights: coerceHighlights(row.highlights),
    spoilers: coerceSpoilers(row.spoilers),
    sources: cleanSources(row.sources),
    createdAt: row.created_at,
    synced: true,
    deleted: false,
  };
}

/**
 * Merge the server list (after this device pushed its changes) into the device store.
 * - server row unknown here → add (saved on another device)
 * - device item marked synced but missing on the server → drop (removed elsewhere)
 * - pushed items/tombstones the caller confirmed → `pushedIds` / `deletedIds`
 * @param {SavedItem[]} items @param {string} owner @param {SavedRow[]} serverRows
 * @param {string[]} [pushedIds] @param {string[]} [deletedIds] @returns {SavedItem[]}
 */
export function mergeRemote(items, owner, serverRows, pushedIds = [], deletedIds = []) {
  const pushed = new Set(pushedIds);
  const deleted = new Set(deletedIds);
  const server = new Map(serverRows.map((row) => [row.id, fromRow(row)]));
  const out = [];
  for (const row of items) {
    if ((row.owner ?? null) !== owner) {
      out.push(row);
      continue;
    }
    // Only drop a tombstone the server confirmed; an Undo during the sync restored it.
    if (deleted.has(row.id) && row.deleted) continue;
    if (row.deleted) {
      out.push(row);
      continue;
    }
    if (pushed.has(row.id)) {
      out.push({ ...row, synced: true });
      server.delete(row.id);
      continue;
    }
    if (server.has(row.id)) {
      out.push({ ...row, synced: true });
      server.delete(row.id);
      continue;
    }
    if (!row.synced) out.push(row);
  }
  const tombstoned = new Set(items.filter((row) => row.deleted).map((row) => row.id));
  for (const [id, row] of server) {
    if (tombstoned.has(id)) continue;
    // Pushed this sync but removed locally while the upsert was in flight: the server
    // now has it, so keep a tombstone (next sync deletes it) instead of re-adding it.
    if (pushed.has(id)) out.push({ ...row, deleted: true });
    else out.push(row);
  }
  return out;
}

/** List preview: markdown stripped, first ~120 chars. @param {string} content */
export function savedPreview(content) {
  const flat = String(content || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, "")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat;
}

/** Spoiler-gated replies never preview their text in the list. @param {{ spoilers?: unknown }} item */
export function isSpoilerGated(item) {
  return Array.isArray(item.spoilers) && item.spoilers.length > 0;
}

/**
 * Same gate as the chat (message-list.tsx): the answer text is always shown, and major
 * spoiler reveals exist only when the player has major spoilers on. So the list preview
 * is the answer text, plus a "tap to reveal" hint only when reveals would be shown.
 * @param {{ spoilers?: unknown }} item @param {boolean} spoilerMajor
 */
export function showsSpoilerHint(item, spoilerMajor) {
  return spoilerMajor && isSpoilerGated(item);
}

/**
 * A reply that can be bookmarked: finished text. Aborted/failed turns are rolled back
 * to the prior messages (execute-chat-turn.ts), so the only unfinished assistant
 * message left in a thread is the "Writing answer..." placeholder (or empty text).
 * @param {{ role?: string, content?: unknown }} message
 */
export function isSavableReply(message) {
  if (message.role !== "assistant" || typeof message.content !== "string") return false;
  const text = message.content.trim();
  return text.length > 0 && text !== WRITING_ANSWER_PLACEHOLDER;
}

/**
 * Supabase error for a missing table (PostgREST PGRST205 / Postgres 42P01), e.g.
 * `public.saved_answers` before db/saved-answers.sql is applied. Mirrors
 * isTopicColumnDbError in game-room.js.
 * @param {unknown} error
 */
export function isMissingTableError(error) {
  if (!error || typeof error !== "object") return false;
  const record = /** @type {{ code?: unknown, message?: unknown }} */ (error);
  const code = String(record.code ?? "");
  const msg = String(record.message ?? "");
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    /Could not find the table/i.test(msg) ||
    /relation .* does not exist/i.test(msg)
  );
}

/**
 * "Today", "Yesterday", or "3 Nov" (year added when not this year).
 * @param {string} iso @param {Date} [now]
 */
export function savedDateLabel(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** True once per device: the first signed-out save shows the "sign in to sync" hint. */
export function consumeAnonSaveHint() {
  try {
    if (window.localStorage.getItem(SAVED_ANON_HINT_KEY)) return false;
    window.localStorage.setItem(SAVED_ANON_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
