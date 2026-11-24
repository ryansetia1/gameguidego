/**
 * Saved maps: VGMaps maps a player keeps per game. Metadata only (the image binary lives
 * in the browser Cache API, phase 3). Same model as lib/saved-answers.js: a device copy
 * in localStorage for everyone, plus a Supabase copy (`public.saved_maps`, phase 2) for
 * signed-in users merged by `mergeRemoteMaps`.
 *
 * Item: { id, owner, gameKey, game, platform, title, author, sourceUrl, imageUrl,
 *         dimensions, fileSize, format, width, height, lastZoom, lastOffsetX, lastOffsetY,
 *         createdAt, synced, deleted }
 * - owner: user id, or null for signed-out saves (claimed by the next signed-in sync).
 * - synced: the server has this exact item. deleted: tombstone waiting for a server delete.
 * - One item per owner + game + imageUrl (the server's unique index).
 *
 * Plan: docs/plan/vgmaps-map-viewer.md (section 3A.3).
 */

import { normGameKey } from "./game-room.js";
import { parseDimensions } from "./vgmaps-parser.js";

export { isMissingTableError } from "./saved-answers.js";

export const SAVED_MAPS_KEY = "gg:saved-maps";
export const MAPS_PER_GAME_CAP = 12;
export const MAPS_DEVICE_CAP = 40;

/**
 * @typedef {{
 *   id: string, owner: string|null, gameKey: string, game: string, platform: string,
 *   title: string, author: string, sourceUrl: string, imageUrl: string,
 *   dimensions: string, fileSize: string, format: string,
 *   width: number|null, height: number|null,
 *   lastZoom: number, lastOffsetX: number, lastOffsetY: number,
 *   createdAt: string, synced: boolean, deleted: boolean,
 * }} SavedMap
 * @typedef {Record<string, any>} SavedMapRow
 */

/** @returns {SavedMap[]} every stored item (tombstones included), or [] when unreadable */
export function loadSavedMaps() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_MAPS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((/** @type {any} */ row) => row && typeof row.id === "string" && typeof row.imageUrl === "string")
      : [];
  } catch {
    return [];
  }
}

/** Throws on quota / private-mode errors so callers can surface "Couldn't save". @param {SavedMap[]} items */
export function writeSavedMaps(items) {
  window.localStorage.setItem(SAVED_MAPS_KEY, JSON.stringify(items));
}

/** @param {SavedMap[]} items @param {string|null} owner @returns {SavedMap[]} */
export function visibleMaps(items, owner) {
  return items.filter((row) => !row.deleted && (row.owner ?? null) === (owner ?? null));
}

/** Newest-first saved maps for one game. @param {SavedMap[]} items @param {string|null} owner @param {string} game */
export function mapsForGame(items, owner, game) {
  const key = normGameKey(game);
  return visibleMaps(items, owner)
    .filter((row) => row.gameKey === key)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** @param {SavedMap[]} items @param {string|null} owner @param {string} game @param {string} imageUrl */
export function findSavedMap(items, owner, game, imageUrl) {
  const key = normGameKey(game);
  return visibleMaps(items, owner).find((row) => row.gameKey === key && row.imageUrl === imageUrl);
}

/** @param {unknown} value @param {number} fallback */
const num = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
/** @param {unknown} value */
const dim = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

/**
 * Build an item from a VGMaps map link (see VGMapsMapLink in lib/vgmaps-parser.js).
 * @param {{ owner: string|null, game: string, platform?: string, sourceUrl?: string,
 *   map: { mapName?: string, imageUrl: string, author?: string, dimensions?: string,
 *          fileSize?: string, format?: string, width?: number|null, height?: number|null } }} input
 * @param {Date} [now]
 * @returns {SavedMap}
 */
export function buildSavedMap({ owner, game, platform = "", sourceUrl = "", map }, now = new Date()) {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${now.getTime()}-${Math.random().toString(16).slice(2)}`;
  const parsed = parseDimensions(map.dimensions ?? "");
  return {
    id,
    owner: owner ?? null,
    gameKey: normGameKey(game),
    game,
    platform,
    title: map.mapName || "Map",
    author: map.author ?? "",
    sourceUrl,
    imageUrl: map.imageUrl,
    dimensions: map.dimensions ?? "",
    fileSize: map.fileSize ?? "",
    format: map.format ?? "",
    width: dim(map.width) ?? parsed?.width ?? null,
    height: dim(map.height) ?? parsed?.height ?? null,
    lastZoom: 1,
    lastOffsetX: 0,
    lastOffsetY: 0,
    createdAt: now.toISOString(),
    synced: false,
    deleted: false,
  };
}

/**
 * Add a map if caps allow. Saving one that is already saved is a no-op; re-saving one
 * still tombstoned revives that tombstone (same id), so the server's unique
 * owner + game + image index never sees a second row.
 * @param {SavedMap[]} items @param {SavedMap} item
 * @returns {{ items: SavedMap[], error?: undefined } | { error: "cap", items?: undefined }}
 */
export function addSavedMap(items, item) {
  const owner = item.owner ?? null;
  const same = (/** @type {SavedMap} */ row) =>
    (row.owner ?? null) === owner && row.gameKey === item.gameKey && row.imageUrl === item.imageUrl;
  if (items.some((row) => same(row) && !row.deleted)) return { items };
  const mine = visibleMaps(items, owner);
  if (mine.length >= MAPS_DEVICE_CAP) return { error: "cap" };
  if (mine.filter((row) => row.gameKey === item.gameKey).length >= MAPS_PER_GAME_CAP) return { error: "cap" };
  const tomb = items.find((row) => same(row) && row.deleted);
  const next = tomb ? { ...item, id: tomb.id, synced: false, deleted: false } : item;
  return { items: [next, ...items.filter((row) => row.id !== next.id)] };
}

/**
 * Remember where the player left the viewer. Marks the item unsynced so it is re-pushed.
 * @param {SavedMap[]} items @param {string} id
 * @param {{ lastZoom?: number, lastOffsetX?: number, lastOffsetY?: number }} state
 */
export function updateMapViewportState(items, id, state) {
  return items.map((row) =>
    row.id !== id || row.deleted
      ? row
      : {
          ...row,
          lastZoom: num(state.lastZoom, row.lastZoom),
          lastOffsetX: num(state.lastOffsetX, row.lastOffsetX),
          lastOffsetY: num(state.lastOffsetY, row.lastOffsetY),
          synced: false,
        },
  );
}

/** Synced items become tombstones (server delete pending), others just go. @param {SavedMap[]} items @param {string} id */
export function removeSavedMap(items, id) {
  return items.flatMap((row) => {
    if (row.id !== id) return [row];
    return row.synced ? [{ ...row, deleted: true }] : [];
  });
}

/**
 * Signed-out saves on this device become the signed-in user's, within the same caps.
 * ponytail: on a shared device the next sign-in inherits them (same as saved answers).
 * @param {SavedMap[]} items @param {string} owner @returns {SavedMap[]}
 */
export function claimAnonMaps(items, owner) {
  const mine = visibleMaps(items, owner);
  let total = mine.length;
  /** @type {Map<string, number>} */
  const perGame = new Map();
  /** @type {Set<string>} */
  const owned = new Set();
  for (const row of mine) {
    perGame.set(row.gameKey, (perGame.get(row.gameKey) ?? 0) + 1);
    owned.add(`${row.gameKey}\n${row.imageUrl}`);
  }
  return items.flatMap((row) => {
    if ((row.owner ?? null) !== null || row.deleted) return [row];
    // Already saved under this account: the anon copy is a duplicate, drop it.
    if (owned.has(`${row.gameKey}\n${row.imageUrl}`)) return [];
    const inGame = perGame.get(row.gameKey) ?? 0;
    if (total >= MAPS_DEVICE_CAP || inGame >= MAPS_PER_GAME_CAP) return [row];
    total += 1;
    perGame.set(row.gameKey, inGame + 1);
    owned.add(`${row.gameKey}\n${row.imageUrl}`);
    return [{ ...row, owner, synced: false }];
  });
}

/** @param {SavedMap} item @returns {SavedMapRow} */
export function toSavedMapRow(item) {
  return {
    id: item.id,
    user_id: item.owner,
    game_key: item.gameKey,
    game: item.game,
    platform: item.platform,
    title: item.title,
    author: item.author,
    source_url: item.sourceUrl,
    image_url: item.imageUrl,
    dimensions: item.dimensions,
    file_size: item.fileSize,
    format: item.format,
    width: item.width,
    height: item.height,
    last_zoom: item.lastZoom,
    last_offset_x: item.lastOffsetX,
    last_offset_y: item.lastOffsetY,
    created_at: item.createdAt,
  };
}

/** @param {SavedMapRow} row @param {string|null} [owner] @returns {SavedMap} */
export function fromSavedMapRow(row, owner) {
  return {
    id: row.id,
    owner: owner ?? row.user_id ?? null,
    gameKey: row.game_key,
    game: row.game ?? "",
    platform: row.platform ?? "",
    title: row.title ?? "Map",
    author: row.author ?? "",
    sourceUrl: row.source_url ?? "",
    imageUrl: row.image_url,
    dimensions: row.dimensions ?? "",
    fileSize: row.file_size ?? "",
    format: row.format ?? "",
    width: dim(row.width),
    height: dim(row.height),
    lastZoom: num(row.last_zoom, 1),
    lastOffsetX: num(row.last_offset_x, 0),
    lastOffsetY: num(row.last_offset_y, 0),
    createdAt: row.created_at,
    synced: true,
    deleted: false,
  };
}

/**
 * Merge the server list (after this device pushed its changes) into the device store.
 * Same rules as mergeRemote in lib/saved-answers.js, plus: an item already in sync takes
 * the server copy, so a viewport saved on another device wins over a stale local one.
 * @param {SavedMap[]} local @param {SavedMapRow[]} remoteRows @param {string} owner
 * @param {string[]} [pushedIds] items this sync upserted
 * @param {string[]} [deletedIds] tombstones this sync deleted on the server
 * @returns {SavedMap[]}
 */
export function mergeRemoteMaps(local, remoteRows, owner, pushedIds = [], deletedIds = []) {
  const pushed = new Set(pushedIds);
  const deleted = new Set(deletedIds);
  const server = new Map(remoteRows.map((row) => [row.id, fromSavedMapRow(row, owner)]));
  const out = [];
  for (const row of local) {
    if ((row.owner ?? null) !== owner) {
      out.push(row);
      continue;
    }
    if (deleted.has(row.id) && row.deleted) continue;
    if (row.deleted) {
      out.push(row);
      continue;
    }
    const remote = server.get(row.id);
    server.delete(row.id);
    if (pushed.has(row.id)) out.push({ ...row, synced: true });
    // An unsynced local edit not pushed this round (made mid-sync) stays queued.
    else if (remote) out.push(row.synced ? remote : row);
    else if (!row.synced) out.push(row);
  }
  const tombstoned = new Set(local.filter((row) => row.deleted).map((row) => row.id));
  for (const [id, row] of server) {
    if (tombstoned.has(id)) continue;
    out.push(pushed.has(id) ? { ...row, deleted: true } : row);
  }
  return out;
}
