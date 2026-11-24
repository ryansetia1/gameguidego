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
import { isAllowedVGMapsImageUrl, parseDimensions } from "./vgmaps-parser.js";

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

/** One saved map per owner + game + image (the server's unique index). @param {SavedMap} row */
const mapKey = (row) => `${row.owner ?? ""}\n${row.gameKey}\n${row.imageUrl}`;
/** @param {SavedMap} a @param {SavedMap} b */
const sameViewport = (a, b) =>
  a.lastZoom === b.lastZoom && a.lastOffsetX === b.lastOffsetX && a.lastOffsetY === b.lastOffsetY;

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
 * Only VGMaps image URLs are accepted (`error: "invalid"`).
 * @returns {{ items: SavedMap[], error?: undefined } | { error: "cap" | "invalid", items?: undefined }}
 */
export function addSavedMap(items, item) {
  if (!isAllowedVGMapsImageUrl(item.imageUrl)) return { error: "invalid" };
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
 * An anon copy of a map the account already has is dropped; one matching a map the
 * account removed (tombstone not yet deleted on the server) revives that tombstone's id,
 * so the push never adds a second row for the same owner + game + image.
 * ponytail: on a shared device the next sign-in inherits them (same as saved answers).
 * @param {SavedMap[]} items @param {string} owner @returns {SavedMap[]}
 */
export function claimAnonMaps(items, owner) {
  const mine = visibleMaps(items, owner);
  let total = mine.length;
  /** @type {Map<string, number>} */
  const perGame = new Map();
  const owned = new Set(mine.map(mapKey));
  for (const row of mine) perGame.set(row.gameKey, (perGame.get(row.gameKey) ?? 0) + 1);
  const tombs = new Map(
    items.filter((row) => row.owner === owner && row.deleted).map((row) => [mapKey(row), row.id]),
  );
  /** @type {Map<string, SavedMap>} tombstone id → claimed anon map that revives it */
  const revive = new Map();
  const out = items.flatMap((row) => {
    if ((row.owner ?? null) !== null || row.deleted) return [row];
    const claimed = { ...row, owner, synced: false };
    const key = mapKey(claimed);
    if (owned.has(key)) return [];
    const inGame = perGame.get(row.gameKey) ?? 0;
    if (total >= MAPS_DEVICE_CAP || inGame >= MAPS_PER_GAME_CAP) return [row];
    total += 1;
    perGame.set(row.gameKey, inGame + 1);
    owned.add(key);
    const tombId = tombs.get(key);
    if (!tombId) return [claimed];
    revive.set(tombId, claimed);
    return [];
  });
  return out.map((row) => {
    const claimed = revive.get(row.id);
    return claimed ? { ...claimed, id: row.id, deleted: false } : row;
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
    createdAt: typeof row.created_at === "string" && row.created_at ? row.created_at : new Date(0).toISOString(),
    synced: true,
    deleted: false,
  };
}

/**
 * Merge the server list (after this device pushed its changes) into the device store.
 * Same rules as mergeRemote in lib/saved-answers.js, plus:
 * - `pushed` are the snapshots this sync upserted. A row is marked synced only if its
 *   viewport still equals the snapshot; a pan/zoom made while the push was in flight
 *   keeps it unsynced so the next sync sends it.
 * - An item already in sync takes the server copy (a viewport saved on another device).
 * - A local map and a server row for the same owner + game + image under different ids
 *   (saved on two devices) collapse into one under the server id. The local viewport
 *   wins only when it holds an unpushed edit, and then the row stays unsynced.
 * - Server rows whose image URL isn't a VGMaps image are ignored.
 * @param {SavedMap[]} local @param {SavedMapRow[]} remoteRows @param {string} owner
 * @param {SavedMap[]} [pushed] snapshots this sync upserted
 * @param {string[]} [deletedIds] tombstones this sync deleted on the server
 * @returns {SavedMap[]}
 */
export function mergeRemoteMaps(local, remoteRows, owner, pushed = [], deletedIds = []) {
  const pushedById = new Map(pushed.map((row) => [row.id, row]));
  const deleted = new Set(deletedIds);
  const server = new Map(
    remoteRows
      .filter((row) => row && typeof row.id === "string" && isAllowedVGMapsImageUrl(row.image_url))
      .map((row) => [row.id, fromSavedMapRow(row, owner)]),
  );
  /** @type {Map<string, SavedMap>} */
  const serverByKey = new Map([...server.values()].map((row) => [mapKey(row), row]));
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
    const snapshot = pushedById.get(row.id);
    const remote = server.get(row.id);
    if (!remote && !snapshot) {
      // Same map saved on another device under its own id: adopt the server id.
      const twin = serverByKey.get(mapKey(row));
      if (twin && !out.some((kept) => kept.id === twin.id)) {
        server.delete(twin.id);
        out.push(row.synced ? twin : { ...twin, lastZoom: row.lastZoom, lastOffsetX: row.lastOffsetX, lastOffsetY: row.lastOffsetY, synced: sameViewport(row, twin) });
        continue;
      }
      if (twin) continue; // a second local copy of a map already collapsed
    }
    server.delete(row.id);
    if (snapshot) out.push({ ...row, synced: sameViewport(row, snapshot) });
    // An unsynced local edit not pushed this round (made mid-sync) stays queued.
    else if (remote) out.push(row.synced ? remote : row);
    else if (!row.synced) out.push(row);
  }
  const tombstoned = new Set(local.filter((row) => row.deleted).map((row) => row.id));
  for (const [id, row] of server) {
    if (tombstoned.has(id)) continue;
    out.push(pushedById.has(id) ? { ...row, deleted: true } : row);
  }
  return out;
}
