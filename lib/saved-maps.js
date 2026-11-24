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
 * - Server rows whose image URL isn't a VGMaps image are ignored.
 * - One map per owner + game + image: rows sharing that key (the same map saved on two
 *   devices, or a duplicate local copy) collapse into one. It keeps the id of the oldest
 *   row the server has (createdAt, then id), or the oldest local row if the server has
 *   none. It takes the viewport of an unsynced row (an unpushed edit) when there is one,
 *   and then stays unsynced. Losers the server has become tombstones, so the next sync
 *   deletes them; losers it doesn't have are dropped.
 *
 * Sync contract for the caller (phase 3 hook): the server enforces one row per
 * user_id + game_key + image_url (saved_maps_user_game_image_uidx). Either fetch and merge
 * BEFORE pushing, so a map saved on another device is collapsed onto its server id first,
 * or upsert with `onConflict: "user_id,game_key,image_url"`. If a push still fails on that
 * index, leave the row out of `pushed`: the next merge collapses it onto the server row.
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
  const onServer = new Set([...server.keys(), ...pushedById.keys()]);
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
  return collapseSameMap(out, owner, onServer);
}

/**
 * See mergeRemoteMaps: one visible row per owner + game + image.
 * @param {SavedMap[]} items @param {string} owner @param {Set<string>} onServer
 * @returns {SavedMap[]}
 */
function collapseSameMap(items, owner, onServer) {
  /** @type {Map<string, SavedMap[]>} */
  const groups = new Map();
  for (const row of items) {
    if (row.owner !== owner || row.deleted) continue;
    groups.set(mapKey(row), [...(groups.get(mapKey(row)) ?? []), row]);
  }
  /** @type {Map<string, SavedMap|null>} row id → replacement (null = drop) */
  const replace = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const older = (/** @type {SavedMap} */ a, /** @type {SavedMap} */ b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);
    const served = group.filter((row) => onServer.has(row.id)).sort(older);
    const winner = served[0] ?? [...group].sort(older)[0];
    const edit = group.find((row) => !row.synced);
    const kept = edit
      ? { ...winner, lastZoom: edit.lastZoom, lastOffsetX: edit.lastOffsetX, lastOffsetY: edit.lastOffsetY }
      : winner;
    replace.set(winner.id, {
      ...kept,
      synced: winner.synced && onServer.has(winner.id) && sameViewport(kept, winner),
    });
    for (const row of group) {
      if (row.id === winner.id) continue;
      replace.set(row.id, onServer.has(row.id) ? { ...row, synced: true, deleted: true } : null);
    }
  }
  if (!replace.size) return items;
  return items.flatMap((row) => {
    if (!replace.has(row.id) || row.owner !== owner || row.deleted) return [row];
    const next = replace.get(row.id);
    return next ? [next] : [];
  });
}

/**
 * Whether a saved map is still on its game's current VGMaps list (`/api/maps/list` maps).
 * An unlisted map can't be downloaded again (the image proxy only serves listed maps), so
 * it opens from the device cache or not at all. The UI shows it as "no longer listed".
 * @param {{ imageUrl: string }} item @param {{ imageUrl: string }[]} listed
 */
export function isMapListed(item, listed) {
  return listed.some((map) => map.imageUrl === item.imageUrl);
}

/**
 * One sync pass for a signed-in owner (the hook calls it, check.mjs drives it with a fake
 * client). Claims anon saves, deletes tombstones, fetches and merges BEFORE pushing (so a
 * map saved on another device collapses onto its server id first), then upserts the
 * unsynced snapshots on the unique user + game + image key, so a row another device
 * inserted mid-sync is updated instead of failing. Re-reads the store before each merge:
 * the player may save, remove or pan while requests are in flight. Throws the Supabase
 * error (check it with isMissingTableError).
 *
 * `isCurrent` is re-checked after every request: on sign-out or an account switch the
 * shared client's select returns [] under RLS (no error), which the merge would read as
 * "every map removed on another device". The pass then stops without writing anything
 * (`aborted: true`, `final: null`), so the caller must not drop cached images.
 * @param {any} client Supabase client
 * @param {string} owner
 * @param {{ load: () => SavedMap[], write: (items: SavedMap[]) => void,
 *   isCurrent?: () => boolean | Promise<boolean> }} store
 * @returns {Promise<{ start: SavedMap[], final: SavedMap[]|null, aborted: boolean }>}
 */
export async function syncSavedMaps(client, owner, store) {
  const current = async () => (store.isCurrent ? Boolean(await store.isCurrent()) : true);
  const start = store.load();
  if (!(await current())) return { start, final: null, aborted: true };
  const claimed = claimAnonMaps(start, owner);
  store.write(claimed);
  const tombs = claimed.filter((row) => row.owner === owner && row.deleted).map((row) => row.id);
  if (tombs.length) {
    const { error } = await client.from("saved_maps").delete().in("id", tombs);
    if (error) throw error;
  }
  const { data, error } = await client.from("saved_maps").select("*").eq("user_id", owner);
  if (error) throw error;
  /** @type {SavedMapRow[]} */
  const rows = data ?? [];
  if (!(await current())) return { start, final: null, aborted: true };
  let merged = mergeRemoteMaps(store.load(), rows, owner, [], tombs);
  store.write(merged);
  const pushed = merged.filter((row) => row.owner === owner && !row.synced && !row.deleted);
  if (pushed.length) {
    const { error: upsertError } = await client
      .from("saved_maps")
      .upsert(pushed.map(toSavedMapRow), { onConflict: "user_id,game_key,image_url" });
    if (upsertError) throw upsertError;
    if (!(await current())) return { start, final: null, aborted: true };
    // The server now has the pushed rows too: a map removed while the push was in flight
    // becomes a tombstone (deleted next pass) instead of coming back on the next select.
    const pushedIds = new Set(pushed.map((row) => row.id));
    const after = [...rows.filter((row) => !pushedIds.has(row.id)), ...pushed.map(toSavedMapRow)];
    merged = mergeRemoteMaps(store.load(), after, owner, pushed, []);
    store.write(merged);
  }
  return { start, final: merged, aborted: false };
}
