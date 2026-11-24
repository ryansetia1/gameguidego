"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  MAP_UNLISTED_STATUS,
  MapFetchError,
  cancelMapDownload,
  deleteCachedMap,
  downloadMapOnce,
  fetchMapBlob,
  hasCachedMap,
  mapProxyUrl,
  readCachedMapBlob,
} from "@/lib/map-blob-cache.js";
import {
  addSavedMap,
  buildSavedMap,
  findSavedMap,
  isMissingTableError,
  loadSavedMaps,
  mapsForGame,
  removeSavedMap,
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

export type SaveMapResult =
  | { status: "saved"; item: SavedMap }
  | { status: "cap" }
  /** The game's VGMaps page no longer lists this map, so the proxy won't serve it. */
  | { status: "unlisted" }
  | { status: "aborted" }
  | { status: "error" };

export type OpenMapResult =
  | { status: "ok"; blob: Blob; objectUrl: string; fromCache: boolean }
  /** Not in the device cache and no longer on the game's VGMaps list. */
  | { status: "unlisted" }
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

const proxyOf = (item: { imageUrl: string; sourceUrl: string }) => mapProxyUrl(item.imageUrl, item.sourceUrl);

/** Drop cached images no live item points at any more (removed here or on another device). */
function dropOrphanedImages(before: SavedMap[], after: SavedMap[]) {
  const live = new Set(after.filter((row) => !row.deleted).map(proxyOf));
  for (const url of new Set(before.filter((row) => !row.deleted).map(proxyOf))) {
    if (!live.has(url)) void deleteCachedMap(url).catch(() => {});
  }
}

function failure(err: unknown): { status: "unlisted" | "aborted" | "error" } {
  if ((err as { name?: string })?.name === "AbortError") return { status: "aborted" };
  if (err instanceof MapFetchError && err.status === MAP_UNLISTED_STATUS) return { status: "unlisted" };
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
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const syncing = useRef(false);
  const rerun = useRef(false);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncOnce = useCallback(async () => {
    const supabase = getSupabase();
    if (!owner || !supabase || serverTableMissing) return;
    try {
      const { start, final } = await syncSavedMaps(supabase, owner, { load, write: writeStore });
      dropOrphanedImages(start, final as SavedMap[]);
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

  // Unmount: stop the pending viewport sync and running downloads.
  useEffect(
    () => () => {
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
      cancelMapDownload();
    },
    [],
  );

  const track = useCallback(async <T,>(proxyUrl: string, run: () => Promise<T>): Promise<T> => {
    setDownloading((prev) => ({ ...prev, [proxyUrl]: true }));
    try {
      return await run();
    } finally {
      setDownloading((prev) => {
        const next = { ...prev };
        delete next[proxyUrl];
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
        await track(proxyUrl, async () => {
          if (!(await hasCachedMap(proxyUrl))) await downloadMapOnce(proxyUrl);
        });
        // Ask the browser not to evict offline maps under storage pressure (best-effort).
        void navigator.storage?.persist?.().catch(() => {});
        const current = load();
        const again = findSavedMap(current, owner, input.game, item.imageUrl) as SavedMap | undefined;
        if (again) return { status: "saved", item: again };
        const added = addSavedMap(current, item);
        if (added.error) return { status: added.error === "cap" ? "cap" : "error" };
        writeStore(added.items as SavedMap[]);
        void sync();
        const saved = findSavedMap(added.items, owner, input.game, item.imageUrl) as SavedMap;
        return { status: "saved", item: saved };
      } catch (err) {
        return failure(err);
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
    async (map: { imageUrl: string; sourceUrl: string }, signal?: AbortSignal): Promise<OpenMapResult> => {
      const proxyUrl = proxyOf(map);
      try {
        const hit = await readCachedMapBlob(proxyUrl);
        const saved = load().some((row) => !row.deleted && proxyOf(row) === proxyUrl);
        const blob =
          hit ??
          (await track(proxyUrl, () => (saved ? downloadMapOnce(proxyUrl) : fetchMapBlob(proxyUrl, { signal }))));
        return { status: "ok", blob, fromCache: Boolean(hit), objectUrl: URL.createObjectURL(blob) };
      } catch (err) {
        return failure(err);
      }
    },
    [track],
  );

  /** Stop a running download (closing the panel or viewer). */
  const cancelDownload = useCallback((map: { imageUrl: string; sourceUrl: string }) => {
    cancelMapDownload(proxyOf(map));
  }, []);

  /** Remove the saved map and its cached image (unless another saved item uses it). */
  const removeMap = useCallback(
    (item: SavedMap) => {
      try {
        const before = load();
        const next = removeSavedMap(before, item.id) as SavedMap[];
        writeStore(next);
        cancelMapDownload(proxyOf(item));
        dropOrphanedImages(before, next);
        void sync();
        return true;
      } catch {
        return false;
      }
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
    (map: { imageUrl: string; sourceUrl: string }) => Boolean(downloading[proxyOf(map)]),
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
    saveViewport,
  };
}
