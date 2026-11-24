/**
 * Map image binaries for offline maps (#37). Images live in the browser Cache API
 * (`gg-maps-v1`), keyed by their same-origin proxy URL; metadata lives in
 * lib/saved-maps.js. Nothing here touches Supabase. Without the Cache API (old browsers,
 * some private modes) everything still works online, it just never hits the cache.
 * ponytail: no Cache API = saved maps open online only; IndexedDB is the upgrade path.
 *
 * Plan: docs/plan/vgmaps-map-viewer.md (section 3A.4).
 */

export const MAP_CACHE_NAME = "gg-maps-v1";

/**
 * The proxy rejects a map its game page no longer lists with this status. It also uses 400
 * for malformed requests, which mapProxyUrl never builds for a saved map's own URLs.
 */
export const MAP_UNLISTED_STATUS = 400;

/** A proxy fetch that didn't return an image. `status` is the HTTP status (0 = network). */
export class MapFetchError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = "MapFetchError";
    this.status = status;
  }
}

/**
 * Same-origin proxy URL for one map. Must be exactly `?url=<image>&game=<atlas game url>`
 * (that order, URLSearchParams encoding): /api/maps/image rejects anything else.
 * @param {string} imageUrl @param {string} sourceUrl Atlas game URL, with its #fragment
 */
export function mapProxyUrl(imageUrl, sourceUrl) {
  return `/api/maps/image?${new URLSearchParams({ url: imageUrl, game: sourceUrl })}`;
}

/** @returns {Promise<Cache|null>} */
async function openCache() {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(MAP_CACHE_NAME);
  } catch {
    return null; // SecurityError in some private modes
  }
}

/** @param {string} proxyUrl @param {AbortSignal} [signal] @returns {Promise<Response>} an image response */
async function fetchMap(proxyUrl, signal) {
  let res;
  try {
    res = await fetch(proxyUrl, { signal });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === "AbortError") throw err;
    throw new MapFetchError("Couldn't reach the map. Check your connection.", 0);
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) {
    throw new MapFetchError(`Map request failed (${res.status}).`, res.status);
  }
  return res;
}

/**
 * Download through the proxy without storing it (viewing a map that isn't saved).
 * Throws MapFetchError on a non-image answer, AbortError when `signal` fires.
 * @param {string} proxyUrl @param {{ signal?: AbortSignal }} [opts] @returns {Promise<Blob>}
 */
export async function fetchMapBlob(proxyUrl, { signal } = {}) {
  return (await fetchMap(proxyUrl, signal)).blob();
}

/**
 * Download through the proxy and store it. Same errors as fetchMapBlob, plus the Cache
 * API's own error (quota) on a failed store.
 * @param {string} proxyUrl @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ blob: Blob, cached: boolean }>} cached: false when there's no Cache API
 */
export async function fetchAndCacheMapBlob(proxyUrl, { signal } = {}) {
  const res = await fetchMap(proxyUrl, signal);
  const cache = await openCache();
  if (cache) await cache.put(proxyUrl, res.clone());
  return { blob: await res.blob(), cached: Boolean(cache) };
}

/** @type {Map<string, Promise<boolean>>} deletes still running, per proxy URL */
const deleting = new Map();

/** Reads wait for a running delete of the same map, so a quick re-save never sees a stale hit. @param {string} proxyUrl */
async function settledDelete(proxyUrl) {
  await deleting.get(proxyUrl)?.catch(() => false);
}

/** @param {string} proxyUrl @returns {Promise<Blob|null>} the cached image, or null */
export async function readCachedMapBlob(proxyUrl) {
  await settledDelete(proxyUrl);
  const cache = await openCache();
  const hit = cache ? await cache.match(proxyUrl) : undefined;
  return hit ? hit.blob() : null;
}

/** @param {string} proxyUrl */
export async function hasCachedMap(proxyUrl) {
  await settledDelete(proxyUrl);
  const cache = await openCache();
  return Boolean(cache && (await cache.match(proxyUrl)));
}

/** @param {string} proxyUrl @returns {Promise<boolean>} true when an entry was removed */
export function deleteCachedMap(proxyUrl) {
  const run = (deleting.get(proxyUrl) ?? Promise.resolve(false))
    .catch(() => false)
    .then(async () => {
      const cache = await openCache();
      return cache ? cache.delete(proxyUrl) : false;
    })
    .finally(() => {
      if (deleting.get(proxyUrl) === run) deleting.delete(proxyUrl);
    });
  deleting.set(proxyUrl, run);
  return run;
}

/** @type {(proxyUrl: string) => boolean} */
let liveCheck = () => true;
/** @type {Map<string, number>} saves in progress per proxy URL (image stored, metadata not yet) */
const claims = new Map();

/**
 * Tell this module which images saved items still use (the hook passes a check over
 * `gg:saved-maps`, every owner). Until set, everything counts as used and nothing is
 * released. @param {(proxyUrl: string) => boolean} fn
 */
export function setMapLiveCheck(fn) {
  liveCheck = fn;
}

/** @param {string} proxyUrl */
const inUse = (proxyUrl) => liveCheck(proxyUrl) || (claims.get(proxyUrl) ?? 0) > 0;

/**
 * Store the image first, then run `save` (the metadata write). The URL is claimed while
 * this runs, so the download's own "still used?" check keeps it. If `save` doesn't save
 * (cap, error) or anything throws (download failed or aborted, quota), the image is
 * deleted again unless something else uses it, so a failed save never leaves up to 30 MB.
 * @template {{ saved: boolean }} T
 * @param {string} proxyUrl @param {() => T} save may throw
 * @returns {Promise<T>}
 */
export async function storeMapThenSave(proxyUrl, save) {
  claims.set(proxyUrl, (claims.get(proxyUrl) ?? 0) + 1);
  const unclaim = () => {
    const left = (claims.get(proxyUrl) ?? 1) - 1;
    if (left > 0) claims.set(proxyUrl, left);
    else claims.delete(proxyUrl);
  };
  const release = async () => {
    unclaim();
    if (!inUse(proxyUrl)) await deleteCachedMap(proxyUrl).catch(() => false);
  };
  let result;
  try {
    if (!(await hasCachedMap(proxyUrl))) await downloadMapOnce(proxyUrl);
    result = save();
  } catch (err) {
    await release();
    throw err;
  }
  if (result.saved) unclaim();
  else await release();
  return result;
}

/** @type {Map<string, { promise: Promise<Blob>, controller: AbortController }>} */
const inflight = new Map();

/**
 * fetchAndCacheMapBlob, one request per proxy URL at a time: repeat taps while a map
 * downloads share the running request (and its abort). When it lands, the stored copy is
 * deleted again if nothing uses it any more (the map was removed here or on another device
 * while it downloaded); a save in progress holds a claim and keeps it.
 * @param {string} proxyUrl @returns {Promise<Blob>}
 */
export function downloadMapOnce(proxyUrl) {
  const running = inflight.get(proxyUrl);
  if (running) return running.promise;
  const controller = new AbortController();
  const promise = fetchAndCacheMapBlob(proxyUrl, { signal: controller.signal })
    .then(async (res) => {
      if (res.cached && !inUse(proxyUrl)) await deleteCachedMap(proxyUrl).catch(() => false);
      return res.blob;
    })
    .finally(() => inflight.delete(proxyUrl));
  inflight.set(proxyUrl, { promise, controller });
  return promise;
}

/**
 * Delete every cached map image nothing uses (no saved item, no save or download in
 * progress). Catches what a single remove can't see: a pass that stopped early, or images
 * left by an older build. @returns {Promise<number>} entries deleted
 */
export async function sweepUnusedMaps() {
  const cache = await openCache();
  if (!cache) return 0;
  const keys = await cache.keys();
  let deleted = 0;
  for (const request of keys) {
    const url = new URL(request.url, "http://local");
    const proxyUrl = `${url.pathname}${url.search}`;
    if (inUse(proxyUrl) || inflight.has(proxyUrl)) continue;
    if (await deleteCachedMap(proxyUrl).catch(() => false)) deleted += 1;
  }
  return deleted;
}

/** Abort a running download (every caller sharing it gets AbortError). @param {string} proxyUrl */
export function cancelMapDownload(proxyUrl) {
  inflight.get(proxyUrl)?.controller.abort();
}
