"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  MAP_TOO_LARGE_STATUS,
  MAP_UNLISTED_STATUS,
  MapFetchError,
  cacheMapBlob,
  cancelMapDownload,
  downloadMapOnce,
  fetchMapBlob,
  mapProxyUrl,
  readCachedMapBlob,
  setMapLiveCheck,
  storeMapThenSave,
  sweepUnusedMaps,
} from "@/lib/map-blob-cache.js";
import {
  addSavedMap,
  buildSavedMap,
  findSavedMap,
  isMissingTableError,
  loadSavedMaps,
  mapsForGame,
  removeSavedMap,
  restoreSavedMap,
  syncSavedMaps,
  updateMapViewportState,
  visibleMaps,
  writeSavedMaps,
} from "@/lib/saved-maps.js";
import { getSupabase } from "@/lib/supabase";
import type { VGMapsGameEntry, VGMapsMapLink } from "@/lib/vgmaps-parser.js";

export type SavedMap = {
  id: string;
  owner: string | null;
  gameKey: string;
  game: string;
  platform: string;
  title: string;
  author: string;
  sourceUrl: string;
  imageUrl: string;
  dimensions: string;
  fileSize: string;
  format: string;
  width: number | null;
  height: number | null;
  lastZoom: number;
  lastOffsetX: number;
  lastOffsetY: number;
  createdAt: string;
  synced: boolean;
  deleted: boolean;
};

export type MapViewport = { lastZoom?: number; lastOffsetX?: number; lastOffsetY?: number };

export type MapDownloadProgress = { loaded: number; total: number | null };

export type SaveMapResult =
  | { status: "saved"; item: SavedMap }
  | { status: "cap" }
  | { status: "quota" }
  | { status: "too_large" }
  /** The game's VGMaps page no longer lists this map, so the proxy won't serve it. */
  | { status: "unlisted" }
  | { status: "aborted" }
  | { status: "error" };

export type OpenMapResult =
  | { status: "ok"; blob: Blob; objectUrl: string; fromCache: boolean }
  | { status: "offline" }
  | { status: "too_large" }
  /** Not in the device cache and no longer on the game's VGMaps list. */
  | { status: "unlisted" }
  /** VGMaps refused or failed the image (403/404/5xx through the proxy). */
  | { status: "unavailable" }
  | { status: "aborted" }
  | { status: "error" };

const VIEWPORT_SYNC_DELAY_MS = 600;

// Set once the server says `saved_maps` doesn't exist: device-only and quiet for the session.
let serverTableMissing = false;

// Device store (`gg:saved-maps`) as an external store, same as use-saved-answers.tsx.
const EMPTY: SavedMap[] = [];
let snapshot: SavedMap[] | null = null;
const listeners = new Set<() => void>();

const load = () => loadSavedMaps() as SavedMap[];

function readStore(): SavedMap[] {
  if (!snapshot) snapshot = load();
  return snapshot;
}

/** Persist (throws on quota/private mode) and notify readers. */
function writeStore(next: SavedMap[]) {
  writeSavedMaps(next);
  snapshot = next;
  listeners.forEach((fn) => fn());
}

function subscribeStore(fn: () => void) {
  listeners.add(fn);
  const onStorage = () => {
    snapshot = null;
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

function subscribeOnline(fn: () => void) {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
}

/** What locates a map image: the VGMaps image URL and its Atlas game URL. */
export type MapRef = { imageUrl: string; sourceUrl: string };

const proxyOf = (item: MapRef) => mapProxyUrl(item.imageUrl, item.sourceUrl);

/** Whether any saved item on this device (any owner) still uses this image. */
const isLive = (proxyUrl: string) => load().some((row) => !row.deleted && proxyOf(row) === proxyUrl);
setMapLiveCheck(isLive);

// Bumped on every sign-out. A sync pass that saw one (even signing back in as the same user,
// whose select may have run with no session and returned []) stops without writing.
let signOuts = 0;

function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function saveFailure(err: unknown): { status: "unlisted" | "too_large" | "quota" | "aborted" | "error" } {
  if ((err as { name?: string })?.name === "AbortError") return { status: "aborted" };
  if (err instanceof MapFetchError && err.status === MAP_UNLISTED_STATUS) return { status: "unlisted" };
  if (err instanceof MapFetchError && err.status === MAP_TOO_LARGE_STATUS) return { status: "too_large" };
  if (isQuotaError(err)) return { status: "quota" };
  return { status: "error" };
}

function openFailure(err: unknown): { status: "unlisted" | "too_large" | "unavailable" | "aborted" | "error" } {
  if ((err as { name?: string })?.name === "AbortError") return { status: "aborted" };
  if (err instanceof MapFetchError && err.status === MAP_UNLISTED_STATUS) return { status: "unlisted" };
  if (err instanceof MapFetchError && err.status === MAP_TOO_LARGE_STATUS) return { status: "too_large" };
  // Proxy answers 502 for any upstream block/failure; 0 is the phone's own network error.
  if (err instanceof MapFetchError && (err.status === 403 || err.status === 404 || err.status >= 500)) {
    return { status: "unavailable" };
  }
  return { status: "error" };
}

/**
 * Device-first saved maps (#37). Metadata in localStorage for everyone, images in the
 * Cache API (`gg-maps-v1`), never in Supabase. Signed-in users sync metadata to
 * `public.saved_maps` on open, on `online`, after each change and (debounced) after a
 * viewport change. Sync never blocks: a failure flips `syncFailed` and retries later.
 */
export function useSavedMaps(user: User | null) {
  const owner = user?.id ?? null;
  const items = useSyncExternalStore(subscribeStore, readStore, () => EMPTY);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [syncFailed, setSyncFailed] = useState(false);
  const [syncAvailable, setSyncAvailable] = useState(() => !serverTableMissing);
  // Callers waiting per proxy URL (a save and an open can share one download).
  const [downloading, setDownloading] = useState<Record<string, number>>({});
  const syncing = useRef(false);
  const rerun = useRef(false);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The signed-in owner right now; a sync pass started for someone else stops writing.
  const ownerRef = useRef(owner);
  useEffect(() => {
    ownerRef.current = owner;
  }, [owner]);
  useEffect(() => {
    const sub = getSupabase()?.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") signOuts += 1;
    });
    return () => sub?.data.subscription.unsubscribe();
  }, []);

  const syncOnce = useCallback(async () => {
    const supabase = getSupabase();
    if (!owner || !supabase || serverTableMissing) return;
    try {
      const generation = signOuts;
      const isCurrent = async () =>
        signOuts === generation &&
        ownerRef.current === owner &&
        (await supabase.auth.getSession()).data.session?.user.id === owner;
      const { aborted } = await syncSavedMaps(supabase, owner, { load, write: writeStore, isCurrent });
      if (aborted) return;
      // Full sweep, not a before/after diff: also cleans what an earlier aborted pass left.
      await sweepUnusedMaps().catch(() => 0);
      setSyncFailed(false);
    } catch (error) {
      if (isMissingTableError(error)) {
        serverTableMissing = true;
        setSyncAvailable(false);
        setSyncFailed(false);
        return;
      }
      setSyncFailed(true);
    }
  }, [owner]);

  // Read through a ref so a queued pass uses the current owner.
  const syncOnceRef = useRef(syncOnce);
  useEffect(() => {
    syncOnceRef.current = syncOnce;
  }, [syncOnce]);

  /** One sync at a time; a request during a run queues exactly one more pass. */
  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    if (syncing.current) {
      rerun.current = true;
      return;
    }
    syncing.current = true;
    do {
      rerun.current = false;
      await syncOnceRef.current();
    } while (rerun.current);
    syncing.current = false;
  }, []);

  useEffect(() => {
    if (owner && online) void sync();
  }, [owner, online, sync]);

  // Unmount: drop the pending viewport sync (the next open/online sync sends it). Running
  // downloads are shared with other hook instances, so only cancelDownload stops one.
  useEffect(
    () => () => {
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
    },
    [],
  );

  const track = useCallback(async <T,>(proxyUrl: string, run: () => Promise<T>): Promise<T> => {
    setDownloading((prev) => ({ ...prev, [proxyUrl]: (prev[proxyUrl] ?? 0) + 1 }));
    try {
      return await run();
    } finally {
      setDownloading((prev) => {
        const next = { ...prev, [proxyUrl]: (prev[proxyUrl] ?? 1) - 1 };
        if (next[proxyUrl] <= 0) delete next[proxyUrl];
        return next;
      });
    }
  }, []);

  /**
   * Download the image into the device cache, then save the metadata. Repeat taps while it
   * downloads share one request. Nothing is saved if the image couldn't be stored, so a
   * saved map always opens offline (except without the Cache API, where it opens online).
   */
  const saveMap = useCallback(
    async (input: {
      game: string;
      platform?: string;
      gameEntry: Pick<VGMapsGameEntry, "url">;
      mapLink: VGMapsMapLink;
      onProgress?: (progress: MapDownloadProgress) => void;
      /** The image already downloaded by the viewer; saves it without a second download. */
      blob?: Blob | null;
    }): Promise<SaveMapResult> => {
      const item = buildSavedMap({
        owner,
        game: input.game,
        platform: input.platform ?? "",
        sourceUrl: input.gameEntry.url,
        map: input.mapLink,
      }) as SavedMap;
      const existing = findSavedMap(load(), owner, input.game, item.imageUrl) as SavedMap | undefined;
      if (existing) return { status: "saved", item: existing };
      const precheck = addSavedMap(load(), item);
      if (precheck.error) return { status: precheck.error === "cap" ? "cap" : "error" };
      const proxyUrl = proxyOf(item);
      try {
        const result = await track(proxyUrl, () =>
          storeMapThenSave(
            proxyUrl,
            (): { saved: boolean; out: SaveMapResult } => {
              const current = load();
              const again = findSavedMap(current, owner, input.game, item.imageUrl) as SavedMap | undefined;
              if (again) return { saved: true, out: { status: "saved", item: again } };
              const added = addSavedMap(current, item);
              if (added.error) return { saved: false, out: { status: added.error === "cap" ? "cap" : "error" } };
              writeStore(added.items as SavedMap[]); // throws on quota: the image is released
              const saved = findSavedMap(added.items, owner, input.game, item.imageUrl) as SavedMap;
              return { saved: true, out: { status: "saved", item: saved } };
            },
            { onProgress: input.onProgress, blob: input.blob },
          ),
        );
        if (result.saved) {
          // Ask the browser not to evict offline maps under storage pressure (best-effort).
          void navigator.storage?.persist?.().catch(() => {});
          void sync();
        }
        return result.out;
      } catch (err) {
        return saveFailure(err);
      }
    },
    [owner, sync, track],
  );

  /**
   * Image for the viewer: device cache first (offline). On a miss a saved map is downloaded
   * back into the cache (sharing a running save); a map that isn't saved is only fetched,
   * so browsing never fills the device. The caller owns `objectUrl` and must revoke it on
   * close or map switch. `signal` only cancels the not-saved fetch.
   */
  const openMap = useCallback(
    async (
      map: MapRef,
      signal?: AbortSignal,
      onProgress?: (progress: MapDownloadProgress) => void,
    ): Promise<OpenMapResult> => {
      const proxyUrl = proxyOf(map);
      try {
        const hit = await readCachedMapBlob(proxyUrl);
        if (!hit && typeof navigator !== "undefined" && !navigator.onLine) {
          return { status: "offline" };
        }
        const saved = load().some((row) => !row.deleted && proxyOf(row) === proxyUrl);
        const blob =
          hit ??
          (await track(proxyUrl, () =>
            saved
              ? downloadMapOnce(proxyUrl, { onProgress })
              : fetchMapBlob(proxyUrl, { signal, onProgress }),
          ));
        return { status: "ok", blob, fromCache: Boolean(hit), objectUrl: URL.createObjectURL(blob) };
      } catch (err) {
        return openFailure(err);
      }
    },
    [track],
  );

  /**
   * Stop a running download (closing the panel or viewer). The download is shared, so this
   * also stops a save of the same map; the save then reports "aborted" and keeps nothing.
   */
  const cancelDownload = useCallback((map: MapRef) => {
    cancelMapDownload(proxyOf(map));
  }, []);

  /**
   * Remove the saved map and its cached image (unless another saved item uses it). Resolves
   * once the image is gone; a re-save started earlier still waits for that delete.
   */
  const removeMap = useCallback(
    async (item: SavedMap) => {
      try {
        writeStore(removeSavedMap(load(), item.id) as SavedMap[]);
      } catch {
        return false;
      }
      await sweepUnusedMaps().catch(() => 0);
      void sync();
      return true;
    },
    [sync],
  );

  /**
   * Undo a remove: re-store the metadata and (when provided) the previously cached image
   * blob so Undo stays instant and works even offline.
   */
  const restoreMap = useCallback(
    async (item: SavedMap, cachedBlob?: Blob | null) => {
      if ((item.owner ?? null) !== ownerRef.current) return false;
      try {
        writeStore(restoreSavedMap(load(), item) as SavedMap[]);
      } catch {
        return false;
      }
      if (cachedBlob) {
        await cacheMapBlob(proxyOf(item), cachedBlob).catch(() => false);
      }
      void sync();
      return true;
    },
    [sync],
  );

  /** Remember the viewer position now; the server copy follows 600ms after the last change. */
  const saveViewport = useCallback(
    (id: string, state: MapViewport) => {
      try {
        writeStore(updateMapViewportState(load(), id, state) as SavedMap[]);
      } catch {
        return; // quota: the position just isn't remembered
      }
      if (!owner) return;
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => {
        viewportTimer.current = null;
        void sync();
      }, VIEWPORT_SYNC_DELAY_MS);
    },
    [owner, sync],
  );

  const forGame = useCallback((game: string) => mapsForGame(items, owner, game) as SavedMap[], [items, owner]);
  const findSaved = useCallback(
    (game: string, imageUrl: string) => findSavedMap(items, owner, game, imageUrl) as SavedMap | undefined,
    [items, owner],
  );
  const byId = useCallback(
    (id: string) => visibleMaps(items, owner).find((row) => row.id === id) as SavedMap | undefined,
    [items, owner],
  );
  const isDownloading = useCallback(
    (map: MapRef) => Boolean(downloading[proxyOf(map)]),
    [downloading],
  );

  return {
    forGame,
    findSaved,
    byId,
    isDownloading,
    online,
    syncFailed,
    /** False when sync is off for this session (server table missing). */
    syncAvailable,
    saveMap,
    openMap,
    cancelDownload,
    removeMap,
    restoreMap,
    saveViewport,
  };
}
