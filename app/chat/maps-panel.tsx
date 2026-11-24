"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ClearButton } from "../clear-button";
import { IconArrowLeft, IconDotsVertical, IconX } from "../icons";
import { SPLIT_QUERY } from "./saved-answers-panel";
import type {
  MapDownloadProgress,
  MapRef,
  SaveMapResult,
  SavedMap,
} from "./use-saved-maps";
import { hasCachedMap, mapProxyUrl } from "@/lib/map-blob-cache.js";
import {
  type MapsTab,
  defaultMapsQuery,
  defaultMapsTab,
  downloadProgressRatio,
  formatDownloadProgressText,
  formatFindMapMeta,
  formatSavedMapMeta,
  isMapOverLimit,
  parseMapsSearchQuery,
} from "@/lib/maps-panel.js";
import type { VGMapsGameEntry, VGMapsMapLink } from "@/lib/vgmaps-parser.js";

// Remember the user's last explicit tab switch in memory only (never persisted across reloads).
let lastUsedMapsTab: MapsTab | null = null;

function subscribeSplit(fn: () => void) {
  const mq = window.matchMedia(SPLIT_QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

function useSplitLayout() {
  return useSyncExternalStore(
    subscribeSplit,
    () => window.matchMedia(SPLIT_QUERY).matches,
    () => false,
  );
}

/** Keep Tab inside the narrow drawer dialog (includes text/search inputs). */
function trapTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusables = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export type MapsPanelProps = {
  game: string;
  platform: string;
  savedItems: SavedMap[];
  /** An overlay (sidebar, library, menu, dialog) is open above the side panel. */
  inert?: boolean;
  /** True while the full-screen MapViewer dialog is open on top of this panel. */
  viewerOpen?: boolean;
  /** Increment when viewer closes or cache mutates so cached status refreshes. */
  cacheVersion?: number;
  signedIn: boolean;
  online: boolean;
  syncFailed: boolean;
  syncAvailable: boolean;
  findSaved: (game: string, imageUrl: string) => SavedMap | undefined;
  isDownloading: (map: MapRef) => boolean;
  onSaveMap: (input: {
    game: string;
    platform?: string;
    gameEntry: Pick<VGMapsGameEntry, "url">;
    mapLink: VGMapsMapLink;
    onProgress?: (progress: MapDownloadProgress) => void;
  }) => Promise<SaveMapResult>;
  onCancelDownload: (map: MapRef) => void;
  onOpenSavedMap: (item: SavedMap) => void;
  onOpenFindMap: (
    gameEntry: VGMapsGameEntry,
    mapLink: VGMapsMapLink,
    saved?: SavedMap,
  ) => void;
  onRemoveSavedMap: (item: SavedMap) => void;
  onToast: (message: string) => void;
  onClose: () => void;
};

type FetchStatus = "idle" | "loading" | "done" | "error";

/**
 * Per-game Maps side column / drawer (#39). Mirrors SavedAnswersPanel's shell: wide
 * viewports & landscape handhelds show a right column beside chat; narrow viewports show
 * a right drawer with backdrop, focus trap, and Esc close.
 */
export function MapsPanel({
  game,
  platform,
  savedItems,
  inert = false,
  viewerOpen = false,
  cacheVersion = 0,
  signedIn,
  online,
  syncFailed,
  syncAvailable,
  findSaved,
  isDownloading,
  onSaveMap,
  onCancelDownload,
  onOpenSavedMap,
  onOpenFindMap,
  onRemoveSavedMap,
  onToast,
  onClose,
}: MapsPanelProps) {
  const split = useSplitLayout();
  const paneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gameRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const mountedRef = useRef(true);
  const gameKey = `${game}\n${platform}`;
  const currentGameKeyRef = useRef(gameKey);
  currentGameKeyRef.current = gameKey;
  const savedTabRef = useRef<HTMLButtonElement>(null);
  const findTabRef = useRef<HTMLButtonElement>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<MapsTab>(() =>
    defaultMapsTab(savedItems.length, lastUsedMapsTab),
  );
  const [menuId, setMenuId] = useState<string | null>(null);
  const [offlineNoticeId, setOfflineNoticeId] = useState<string | null>(null);
  const [cachedByProxy, setCachedByProxy] = useState<Record<string, boolean>>({});

  // Find tab state (Step 1: VGMaps games, Step 2: selected game's maps).
  const [query, setQuery] = useState(() => defaultMapsQuery(game, platform));
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<FetchStatus>("idle");
  const [gameResults, setGameResults] = useState<VGMapsGameEntry[]>([]);
  const [selectedGame, setSelectedGame] = useState<VGMapsGameEntry | null>(null);
  const [listStatus, setListStatus] = useState<FetchStatus>("idle");
  const [mapLinks, setMapLinks] = useState<VGMapsMapLink[]>([]);

  // Per-map download progress and error/limit status (keyed by imageUrl).
  const [progressByUrl, setProgressByUrl] = useState<Record<string, MapDownloadProgress>>({});
  const [failedByUrl, setFailedByUrl] = useState<Record<string, boolean>>({});
  const [tooLargeByUrl, setTooLargeByUrl] = useState<Record<string, boolean>>({});
  const [downloadAnnouncement, setDownloadAnnouncement] = useState("");

  const userEditedQueryRef = useRef(false);
  const autoSearchedGameRef = useRef<string | null>(null);
  const step1ScrollTopRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchGenRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const listGenRef = useRef(0);
  const prevGameKeyRef = useRef(`${game}\n${platform}`);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectTab = useCallback((next: MapsTab, focus = false) => {
    lastUsedMapsTab = next;
    setActiveTab(next);
    setMenuId(null);
    if (focus) {
      requestAnimationFrame(() => {
        (next === "saved" ? savedTabRef : findTabRef).current?.focus();
      });
    }
  }, []);

  // Reset Find state cleanly if the active game changes while the panel stays open (split mode).
  useEffect(() => {
    const key = `${game}\n${platform}`;
    if (prevGameKeyRef.current === key) return;
    prevGameKeyRef.current = key;
    searchAbortRef.current?.abort();
    listAbortRef.current?.abort();
    searchGenRef.current += 1;
    listGenRef.current += 1;
    userEditedQueryRef.current = false;
    autoSearchedGameRef.current = null;
    step1ScrollTopRef.current = 0;
    setQuery(defaultMapsQuery(game, platform));
    setSubmittedQuery("");
    setSearchStatus("idle");
    setGameResults([]);
    setSelectedGame(null);
    setListStatus("idle");
    setMapLinks([]);
    setProgressByUrl({});
    setFailedByUrl({});
    setTooLargeByUrl({});
    setOfflineNoticeId(null);
    setMenuId(null);
  }, [game, platform]);

  // Abort any in-flight search/list requests on unmount. If a search was aborted while still
  // in flight (e.g. React Strict Mode remount), clear autoSearchedGameRef so remount retries.
  useEffect(() => {
    return () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
        searchAbortRef.current = null;
        autoSearchedGameRef.current = null;
      }
      if (listAbortRef.current) {
        listAbortRef.current.abort();
        listAbortRef.current = null;
      }
    };
  }, []);

  // Focus close button on open and restore focus to trigger on close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      const target =
        trigger && trigger !== document.body && document.contains(trigger)
          ? trigger
          : (document.querySelector<HTMLElement>(".game-card-maps") ??
            document.querySelector<HTMLElement>(".game-card-menu .kebab"));
      target?.focus();
    };
  }, []);

  // Close row kebab menu when clicking outside.
  useEffect(() => {
    if (!menuId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".row-menu")) setMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuId]);

  // Esc: close row menu first, else close panel (split mode only when focus is inside).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || viewerOpen || inert) return;
      if (split && !paneRef.current?.contains(document.activeElement)) return;
      if (menuId) setMenuId(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [split, menuId, viewerOpen, inert, onClose]);

  // Refresh Cache API presence for every saved map in the current game without leaking blobs.
  useEffect(() => {
    let cancelled = false;
    if (savedItems.length === 0) {
      setCachedByProxy({});
      return;
    }
    const entries = savedItems.map((item) => mapProxyUrl(item.imageUrl, item.sourceUrl));
    void Promise.all(
      entries.map(async (proxyUrl) => [proxyUrl, await hasCachedMap(proxyUrl)] as const),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const [proxyUrl, cached] of results) next[proxyUrl] = cached;
      setCachedByProxy(next);
    });
    return () => {
      cancelled = true;
    };
  }, [savedItems, cacheVersion, online]);

  // Clear stale offline notice once back online.
  useEffect(() => {
    if (online) setOfflineNoticeId(null);
  }, [online]);

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed || !online) return;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const gen = ++searchGenRef.current;

      const parsed = parseMapsSearchQuery(trimmed, game, platform);
      setSubmittedQuery(trimmed);
      setSelectedGame(null);
      setSearchStatus("loading");

      try {
        const params = new URLSearchParams({ game: parsed.game });
        if (parsed.platform) params.set("platform", parsed.platform);
        const res = await fetch(`/api/maps/search?${params.toString()}`, {
          signal: controller.signal,
        });
        if (gen !== searchGenRef.current) return;
        if (!res.ok) {
          setGameResults([]);
          setSearchStatus("error");
          return;
        }
        const data = (await res.json()) as {
          games?: VGMapsGameEntry[];
          available?: boolean;
        };
        if (gen !== searchGenRef.current) return;
        if (data.available === false) {
          setGameResults([]);
          setSearchStatus("error");
          return;
        }
        setGameResults(Array.isArray(data.games) ? data.games : []);
        setSearchStatus("done");
      } catch (err) {
        if (gen !== searchGenRef.current) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setGameResults([]);
        setSearchStatus("error");
      } finally {
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      }
    },
    [game, platform, online],
  );

  // Auto-search once on first open of the Find tab per game (never if the user edited the query).
  useEffect(() => {
    if (activeTab !== "find" || !online || !game.trim()) return;
    if (userEditedQueryRef.current) return;
    if (autoSearchedGameRef.current === game) return;
    autoSearchedGameRef.current = game;
    void runSearch(defaultMapsQuery(game, platform));
  }, [activeTab, online, game, platform, runSearch]);

  const fetchGameMaps = useCallback(
    async (entry: VGMapsGameEntry) => {
      if (!online) return;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      const gen = ++listGenRef.current;

      setListStatus("loading");
      setMapLinks([]);

      try {
        const params = new URLSearchParams({ url: entry.url });
        const res = await fetch(`/api/maps/list?${params.toString()}`, {
          signal: controller.signal,
        });
        if (gen !== listGenRef.current) return;
        if (!res.ok) {
          setMapLinks([]);
          setListStatus("error");
          return;
        }
        const data = (await res.json()) as {
          maps?: VGMapsMapLink[];
          available?: boolean;
        };
        if (gen !== listGenRef.current) return;
        if (data.available === false) {
          setMapLinks([]);
          setListStatus("error");
          return;
        }
        setMapLinks(Array.isArray(data.maps) ? data.maps : []);
        setListStatus("done");
      } catch (err) {
        if (gen !== listGenRef.current) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setMapLinks([]);
        setListStatus("error");
      } finally {
        if (listAbortRef.current === controller) listAbortRef.current = null;
      }
    },
    [online],
  );

  function handleOpenGameEntry(entry: VGMapsGameEntry) {
    step1ScrollTopRef.current = scrollBodyRef.current?.scrollTop ?? 0;
    setSelectedGame(entry);
    requestAnimationFrame(() => (backBtnRef.current ?? closeRef.current)?.focus());
    if (scrollBodyRef.current) scrollBodyRef.current.scrollTop = 0;
    void fetchGameMaps(entry);
  }

  function handleBackToResults() {
    listAbortRef.current?.abort();
    listGenRef.current += 1;
    setSelectedGame(null);
    setListStatus("idle");
    requestAnimationFrame(() => {
      (gameRowRefs.current.get(selectedGame?.url ?? "") ??
        searchInputRef.current ??
        closeRef.current)?.focus();
    });
    requestAnimationFrame(() => {
      if (scrollBodyRef.current) {
        scrollBodyRef.current.scrollTop = step1ScrollTopRef.current;
      }
    });
  }

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim() || !online) return;
    autoSearchedGameRef.current = game;
    void runSearch(query);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(activeTab === "saved" ? "find" : "saved", true);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("saved", true);
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("find", true);
    }
  }

  function handleOpenSavedRow(item: SavedMap) {
    setMenuId(null);
    const proxyUrl = mapProxyUrl(item.imageUrl, item.sourceUrl);
    if (!online && !(cachedByProxy[proxyUrl] ?? false)) {
      if (!(proxyUrl in cachedByProxy)) {
        void hasCachedMap(proxyUrl).then((cached) => {
          if (!cached) setOfflineNoticeId(item.id);
          else onOpenSavedMap(item);
        });
        return;
      }
      setOfflineNoticeId(item.id);
      return;
    }
    setOfflineNoticeId(null);
    onOpenSavedMap(item);
  }

  async function handleSaveMap(mapLink: VGMapsMapLink) {
    if (!selectedGame || !online) return;
    const url = mapLink.imageUrl;
    const saveGameKey = gameKey;
    const canUpdate = () =>
      mountedRef.current && currentGameKeyRef.current === saveGameKey;
    let lastProgressAt = 0;
    let lastProgressText = "";
    setDownloadAnnouncement(`Downloading ${mapLink.mapName}…`);
    setFailedByUrl((prev) => {
      if (!prev[url]) return prev;
      const next = { ...prev };
      delete next[url];
      return next;
    });
    setProgressByUrl((prev) => ({ ...prev, [url]: { loaded: 0, total: mapLink.fileSizeBytes ?? null } }));

    const result = await onSaveMap({
      game,
      platform,
      gameEntry: selectedGame,
      mapLink,
      onProgress: (progress) => {
        if (!canUpdate()) return;
        const now = Date.now();
        const formatted = formatDownloadProgressText(progress);
        if (formatted !== lastProgressText || now - lastProgressAt >= 120) {
          lastProgressAt = now;
          lastProgressText = formatted;
          setProgressByUrl((prev) => ({ ...prev, [url]: progress }));
        }
      },
    });

    if (!canUpdate()) return;

    setProgressByUrl((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });

    if (result.status === "saved") {
      const proxyUrl = mapProxyUrl(mapLink.imageUrl, selectedGame.url);
      setCachedByProxy((prev) => ({ ...prev, [proxyUrl]: true }));
      setDownloadAnnouncement(`${mapLink.mapName} saved offline.`);
      return;
    }
    if (result.status === "aborted") {
      setDownloadAnnouncement("Download canceled.");
      return;
    }
    if (result.status === "too_large") {
      setTooLargeByUrl((prev) => ({ ...prev, [url]: true }));
      setDownloadAnnouncement(`Couldn't save ${mapLink.mapName}.`);
      return;
    }
    if (result.status === "quota") {
      setDownloadAnnouncement(`Couldn't save ${mapLink.mapName}.`);
      onToast("Not enough space on this device. Remove a saved map and try again.");
      return;
    }
    if (result.status === "cap") {
      setDownloadAnnouncement(`Couldn't save ${mapLink.mapName}.`);
      onToast("Saved maps are full. Remove one to add more.");
      return;
    }
    setFailedByUrl((prev) => ({ ...prev, [url]: true }));
    setDownloadAnnouncement(`Couldn't save ${mapLink.mapName}.`);
  }

  const inFindStep2 = activeTab === "find" && selectedGame !== null;
  const idleHelperQuery = defaultMapsQuery(game, platform) || "this game";

  return (
    <>
      <button
        type="button"
        className="library-backdrop open saved-backdrop"
        aria-label="Close maps"
        onClick={onClose}
      />
      <section
        ref={paneRef}
        className="saved-pane maps-pane"
        role={split ? "complementary" : "dialog"}
        aria-modal={split ? undefined : true}
        aria-label="Maps"
        onKeyDown={split ? undefined : trapTab}
        inert={inert}
      >
        <div className="visually-hidden" role="status" aria-live="polite">
          {downloadAnnouncement}
        </div>
        <div className="library-head maps-head">
          {inFindStep2 ? (
            <div className="maps-head-step2">
              <button
                ref={backBtnRef}
                type="button"
                className="maps-back-btn"
                onClick={handleBackToResults}
              >
                <IconArrowLeft size={18} />
                <span>Back to results</span>
              </button>
              <span className="maps-head-selected" title={selectedGame.title}>
                {selectedGame.title}
              </span>
            </div>
          ) : (
            <span className="saved-head-title">
              Maps
              <small className="saved-head-game">{game}</small>
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            className="sidebar-close"
            aria-label="Close maps"
            onClick={onClose}
          >
            <IconX />
          </button>
        </div>

        <div
          className="maps-tabs"
          role="tablist"
          aria-label="Maps sections"
          onKeyDown={handleTabKeyDown}
        >
          <button
            ref={savedTabRef}
            id="maps-tab-saved"
            type="button"
            role="tab"
            className={`maps-tab${activeTab === "saved" ? " is-active" : ""}`}
            aria-selected={activeTab === "saved"}
            aria-controls="maps-tabpanel-saved"
            tabIndex={activeTab === "saved" ? 0 : -1}
            onClick={() => selectTab("saved")}
          >
            Saved ({savedItems.length})
          </button>
          <button
            ref={findTabRef}
            id="maps-tab-find"
            type="button"
            role="tab"
            className={`maps-tab${activeTab === "find" ? " is-active" : ""}`}
            aria-selected={activeTab === "find"}
            aria-controls="maps-tabpanel-find"
            tabIndex={activeTab === "find" ? 0 : -1}
            onClick={() => selectTab("find")}
          >
            Find on VGMaps
          </button>
        </div>

        {activeTab === "saved" ? (
          <div
            id="maps-tabpanel-saved"
            role="tabpanel"
            aria-labelledby="maps-tab-saved"
            className="maps-body"
          >
            {!online && (
              <p className="saved-offline">Offline, showing what&apos;s on this device</p>
            )}
            {savedItems.length === 0 ? (
              <div className="maps-empty">
                <p className="saved-empty-title">No maps saved for this game yet.</p>
                <p className="saved-empty-sub">
                  Find one on VGMaps and tap Save to keep it offline.
                </p>
                <button
                  type="button"
                  className="maps-btn-secondary maps-empty-cta"
                  onClick={() => selectTab("find")}
                >
                  Find on VGMaps
                </button>
              </div>
            ) : (
              <ul className="saved-list">
                {savedItems.map((item) => {
                  const proxyUrl = mapProxyUrl(item.imageUrl, item.sourceUrl);
                  const cached =
                    proxyUrl in cachedByProxy ? cachedByProxy[proxyUrl] : null;
                  const meta = formatSavedMapMeta(item, {
                    cached,
                    signedIn,
                    syncAvailable,
                    syncFailed,
                  });
                  return (
                    <li key={item.id} className="saved-row maps-saved-row">
                      <button
                        type="button"
                        className="saved-row-open"
                        onClick={() => handleOpenSavedRow(item)}
                      >
                        <strong className="saved-row-title">{item.title}</strong>
                        {meta ? <span className="map-meta">{meta}</span> : null}
                        {offlineNoticeId === item.id && (
                          <span className="maps-row-inline-msg" role="status">
                            Offline. Open it once online to keep it on this device.
                          </span>
                        )}
                      </button>
                      <div className="row-menu saved-row-menu">
                        <button
                          type="button"
                          className="kebab"
                          aria-label={`Options for ${item.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuId === item.id}
                          onClick={() =>
                            setMenuId((id) => (id === item.id ? null : item.id))
                          }
                        >
                          <IconDotsVertical />
                        </button>
                        {menuId === item.id && (
                          <div className="row-menu-pop" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu-item"
                              onClick={() => handleOpenSavedRow(item)}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="row-menu-item row-menu-delete"
                              onClick={() => {
                                setMenuId(null);
                                onRemoveSavedMap(item);
                                requestAnimationFrame(() => closeRef.current?.focus());
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div
            id="maps-tabpanel-find"
            role="tabpanel"
            aria-labelledby="maps-tab-find"
            className="maps-body"
          >
            {!inFindStep2 && (
              <form className="maps-search-form" onSubmit={handleSearchSubmit}>
                <div className="field-clear-wrap maps-search-field">
                  <input
                    ref={searchInputRef}
                    type="search"
                    className="maps-search-input"
                    aria-label="Search VGMaps"
                    placeholder="Game title"
                    value={query}
                    disabled={!online}
                    onChange={(event) => {
                      userEditedQueryRef.current = true;
                      setQuery(event.target.value);
                    }}
                  />
                  <ClearButton
                    show={Boolean(query)}
                    disabled={!online}
                    label="Clear search"
                    onClear={() => {
                      userEditedQueryRef.current = true;
                      setQuery("");
                    }}
                  />
                </div>
                <button
                  type="submit"
                  className="maps-search-btn"
                  disabled={!online || !query.trim() || searchStatus === "loading"}
                >
                  Search
                </button>
              </form>
            )}

            <div ref={scrollBodyRef} className="maps-scroll">
              {!online ? (
                <div className="maps-state-block" role="status">
                  <p className="maps-state-text">
                    You&apos;re offline. Saved maps still work.
                  </p>
                </div>
              ) : inFindStep2 ? (
                listStatus === "loading" ? (
                  <ul
                    className="maps-skeleton-list"
                    aria-busy="true"
                    aria-label="Loading maps"
                  >
                    <li className="maps-skeleton-row" />
                    <li className="maps-skeleton-row" />
                    <li className="maps-skeleton-row" />
                    <li className="maps-skeleton-row" />
                  </ul>
                ) : listStatus === "error" ? (
                  <div className="maps-state-block" role="status">
                    <p className="maps-state-error">Couldn&apos;t reach VGMaps.</p>
                    <button
                      type="button"
                      className="maps-btn-secondary"
                      onClick={() => void fetchGameMaps(selectedGame)}
                    >
                      Try again
                    </button>
                  </div>
                ) : listStatus === "done" && mapLinks.length === 0 ? (
                  <div className="maps-state-block" role="status">
                    <p className="maps-state-text">
                      VGMaps lists this game but no maps.
                    </p>
                  </div>
                ) : (
                  <ul className="maps-list">
                    {mapLinks.map((mapLink) => {
                      const savedRecord = findSaved(game, mapLink.imageUrl);
                      const overLimit =
                        isMapOverLimit(mapLink) ||
                        Boolean(tooLargeByUrl[mapLink.imageUrl]);
                      const ref: MapRef = {
                        imageUrl: mapLink.imageUrl,
                        sourceUrl: selectedGame.url,
                      };
                      const rowProgress = progressByUrl[mapLink.imageUrl] ?? null;
                      const downloading =
                        rowProgress !== null || isDownloading(ref);
                      const failed =
                        Boolean(failedByUrl[mapLink.imageUrl]) &&
                        !downloading &&
                        !overLimit &&
                        !savedRecord;
                      const meta = formatFindMapMeta(mapLink);

                      return (
                        <li key={mapLink.imageUrl} className="maps-map-row">
                          <div className="maps-map-info">
                            <strong className="saved-row-title">
                              {mapLink.mapName}
                            </strong>
                            {meta ? <p className="map-meta">{meta}</p> : null}
                            {overLimit ? (
                              <p className="maps-row-error" role="status">
                                Too large to download here (over 30 MB). Save is off for
                                this map.
                              </p>
                            ) : mapLink.isLarge ? (
                              <p className="map-meta-warn">
                                Large file, {mapLink.fileSize || "over 6 MB"}. May take a
                                while on mobile data.
                              </p>
                            ) : null}
                          </div>

                          {downloading && (
                            <div className="maps-progress-block">
                              <div className="maps-progress-head">
                                <p className="maps-progress-text">
                                  {formatDownloadProgressText(rowProgress)}
                                </p>
                                <button
                                  type="button"
                                  className="maps-btn-secondary maps-btn-cancel"
                                  onClick={() => {
                                    setDownloadAnnouncement("Download canceled.");
                                    onCancelDownload(ref);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                              <div className="maps-progress-track" aria-hidden="true">
                                <div
                                  className="maps-progress-fill"
                                  style={{
                                    transform: `scaleX(${downloadProgressRatio(rowProgress)})`,
                                  }}
                                />
                              </div>
                            </div>
                          )}

                          {failed && (
                            <div className="maps-row-failed" role="status">
                              <p className="maps-row-error">
                                Couldn&apos;t save. Check your connection.
                              </p>
                              <button
                                type="button"
                                className="maps-btn-secondary"
                                onClick={() => void handleSaveMap(mapLink)}
                              >
                                Try again
                              </button>
                            </div>
                          )}

                          <div className="maps-row-actions">
                            <button
                              type="button"
                              className="maps-btn-secondary"
                              aria-label={`Open ${mapLink.mapName}`}
                              disabled={overLimit || (!online && !savedRecord)}
                              onClick={() =>
                                onOpenFindMap(selectedGame, mapLink, savedRecord)
                              }
                            >
                              Open
                            </button>
                            {savedRecord ? (
                              <button
                                type="button"
                                className="maps-btn-saved"
                                disabled
                              >
                                Saved
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="maps-btn-primary"
                                aria-label={`Save ${mapLink.mapName}`}
                                disabled={overLimit || downloading || !online}
                                onClick={() => void handleSaveMap(mapLink)}
                              >
                                Save
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : searchStatus === "idle" ? (
                <div className="maps-state-block">
                  <p className="maps-state-text">
                    We search VGMaps for {idleHelperQuery}.
                  </p>
                </div>
              ) : searchStatus === "loading" ? (
                <ul
                  className="maps-skeleton-list"
                  aria-busy="true"
                  aria-label="Searching VGMaps"
                >
                  <li className="maps-skeleton-row" />
                  <li className="maps-skeleton-row" />
                  <li className="maps-skeleton-row" />
                  <li className="maps-skeleton-row" />
                </ul>
              ) : searchStatus === "error" ? (
                <div className="maps-state-block" role="status">
                  <p className="maps-state-error">Couldn&apos;t reach VGMaps.</p>
                  <button
                    type="button"
                    className="maps-btn-secondary"
                    onClick={() => void runSearch(query || defaultMapsQuery(game, platform))}
                  >
                    Try again
                  </button>
                </div>
              ) : gameResults.length === 0 ? (
                <div className="maps-state-block" role="status">
                  <p className="maps-state-text">
                    No VGMaps game found for &ldquo;{submittedQuery}&rdquo;. Try a
                    shorter or alternate title.
                  </p>
                </div>
              ) : (
                <ul className="maps-list">
                  {gameResults.map((entry) => (
                    <li key={entry.url} className="maps-game-item">
                      <button
                        type="button"
                        className="maps-game-row"
                        ref={(element) => {
                          if (element) gameRowRefs.current.set(entry.url, element);
                          else gameRowRefs.current.delete(entry.url);
                        }}
                        onClick={() => handleOpenGameEntry(entry)}
                      >
                        <strong className="saved-row-title">{entry.title}</strong>
                        <span className="map-meta maps-game-platform">
                          {entry.platform}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
