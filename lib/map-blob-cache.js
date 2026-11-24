/**
 * Map image binaries for offline maps (#37). Images live in the browser Cache API
 * (`gg-maps-v1`), keyed by their same-origin proxy URL; metadata lives in
 * lib/saved-maps.js. Nothing here touches Supabase. Without the Cache API (old browsers,
 * some private modes) everything still works online, it just never hits the cache.
 *
 * Plan: docs/plan/vgmaps-map-viewer.md (section 3A.4).
 */

export const MAP_CACHE_NAME = "gg-maps-v1";

/** The proxy rejects a map its game page no longer lists with this status. */
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

/** @param {string} proxyUrl @returns {Promise<Blob|null>} the cached image, or null */
export async function readCachedMapBlob(proxyUrl) {
  const cache = await openCache();
  const hit = cache ? await cache.match(proxyUrl) : undefined;
  return hit ? hit.blob() : null;
}

/** @param {string} proxyUrl */
export async function hasCachedMap(proxyUrl) {
  const cache = await openCache();
  return Boolean(cache && (await cache.match(proxyUrl)));
}

/** @param {string} proxyUrl @returns {Promise<boolean>} true when an entry was removed */
export async function deleteCachedMap(proxyUrl) {
  const cache = await openCache();
  return cache ? cache.delete(proxyUrl) : false;
}

/** @type {Map<string, { promise: Promise<Blob>, controller: AbortController }>} */
const inflight = new Map();

/**
 * fetchAndCacheMapBlob, one request per proxy URL at a time: repeat taps while a map
 * downloads share the running request (and its abort).
 * @param {string} proxyUrl @returns {Promise<Blob>}
 */
export function downloadMapOnce(proxyUrl) {
  const running = inflight.get(proxyUrl);
  if (running) return running.promise;
  const controller = new AbortController();
  const promise = fetchAndCacheMapBlob(proxyUrl, { signal: controller.signal })
    .then((res) => res.blob)
    .finally(() => inflight.delete(proxyUrl));
  inflight.set(proxyUrl, { promise, controller });
  return promise;
}

/** @param {string} proxyUrl */
export function isMapDownloading(proxyUrl) {
  return inflight.has(proxyUrl);
}

/** Abort one running download, or every one when no URL is given. @param {string} [proxyUrl] */
export function cancelMapDownload(proxyUrl) {
  for (const [url, { controller }] of inflight) if (!proxyUrl || url === proxyUrl) controller.abort();
}
