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
import type { MapDownloadProgress, MapRef, SavedMap } from "./use-saved-maps";
import { hasCachedMap, mapProxyUrl } from "@/lib/map-blob-cache.js";
import {
  MAPS_TIMEOUT_MS,
  defaultMapsQuery,
  downloadProgressRatio,
  filterMapsSections,
  formatFindMapMeta,
  formatSavedMapMeta,
  formatSavingText,
  formatVeryLargeRow,
  isMapOverLimit,
  MAPS_SLOW_MS,
  mapsChoiceKey,
  mapsListFailure,
  mapsLoadStage,
  parseMapsSearchQuery,
  resolveMapsGame,
} from "@/lib/maps-panel.js";
import type { VGMapsGameEntry, VGMapsMapLink } from "@/lib/vgmaps-parser.js";

// Filter text for the open game, kept for this session only (never persisted).
let rememberedFilter: { key: string; query: string } | null = null;

// The "Which game?" / "Wrong game?" choice, remembered per game + platform on this device.
const CHOICE_STORE = "gg:maps-game-choice";

function readChoice(game: string, platform: string): VGMapsGameEntry | null {
  try {
    const all = JSON.parse(localStorage.getItem(CHOICE_STORE) ?? "{}") as Record<string, unknown>;
    const hit = all?.[mapsChoiceKey(game, platform)] as Partial<VGMapsGameEntry> | undefined;
    if (
      hit &&
      typeof hit.title === "string" &&
      typeof hit.platform === "string" &&
      typeof hit.url === "string" &&
      hit.url.startsWith("https://")
    ) {
      return { title: hit.title, platform: hit.platform, url: hit.url };
    }
  } catch {
    // Private mode or bad JSON: no remembered choice.
  }
  return null;
}

function writeChoice(game: string, platform: string, entry: VGMapsGameEntry) {
  try {
    const all = JSON.parse(localStorage.getItem(CHOICE_STORE) ?? "{}") as Record<string, unknown>;
    const next = all && typeof all === "object" ? all : {};
    next[mapsChoiceKey(game, platform)] = { title: entry.title, platform: entry.platform, url: entry.url };
    localStorage.setItem(CHOICE_STORE, JSON.stringify(next));
  } catch {
    // Quota / private mode: the choice just isn't remembered.
  }
}

function forgetChoice(game: string, platform: string) {
  try {
    const all = JSON.parse(localStorage.getItem(CHOICE_STORE) ?? "{}") as Record<string, unknown>;
    if (!all || typeof all !== "object") return;
    delete all[mapsChoiceKey(game, platform)];
    localStorage.setItem(CHOICE_STORE, JSON.stringify(all));
  } catch {
    // Nothing stored or storage blocked: nothing to forget.
  }
}

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

/** Lowercase letters/digits only, so "(Super NES)" and "SuperNES" compare equal. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

/** A failed API call that got an HTTP status (lets a 4xx be told apart from "unreachable"). */
class MapsHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new MapsHttpError(res.status);
  const data = (await res.json()) as T & { available?: boolean };
  if (data.available === false) throw new Error("VGMaps unavailable");
  return data;
}

/** State of the "On VGMaps" section. Loading follows the real calls (search, then list). */
type VgState =
  | { kind: "idle" }
  | { kind: "loading"; stage: "search" | "list"; entry?: VGMapsGameEntry; since: number }
  | { kind: "pick"; options: VGMapsGameEntry[] }
  | { kind: "notfound"; query: string }
  /** `entry`: the VGMaps game the failed run used (offers "Wrong game?"). */
  | { kind: "error"; reason: "unreachable" | "missing" | "canceled"; entry?: VGMapsGameEntry }
  | { kind: "done"; entry: VGMapsGameEntry; maps: VGMapsMapLink[] };

type PickerState = {
  status: "idle" | "loading" | "done" | "error" | "canceled";
  /** When the running search started (slow notice after 6s). */
  since: number;
  query: string;
  submitted: string;
  results: VGMapsGameEntry[];
};

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
  /** Running saves (page-level, they outlive the panel and viewer), keyed by image URL. */
  saveProgress: Record<string, MapDownloadProgress>;
  onCancelSave: (map: MapRef) => void;
  /** The "Wrong game?" picker is an in-panel view with its own history entry. */
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onOpenSavedMap: (item: SavedMap) => void;
  onOpenFindMap: (gameEntry: VGMapsGameEntry, mapLink: VGMapsMapLink, saved?: SavedMap) => void;
  onRemoveSavedMap: (item: SavedMap) => void;
  onClose: () => void;
};

/**
 * Per-game Maps side column / drawer / full-screen sheet (#39, #56). One scroller: saved
 * maps first, then the VGMaps maps for the active game (auto-resolved, "Wrong game?" to
 * change it). Wide viewports & landscape handhelds show a column beside chat; 601–899px a
 * right drawer; ≤600px a full-screen sheet with a focus trap.
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
  saveProgress,
  onCancelSave,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onOpenSavedMap,
  onOpenFindMap,
  onRemoveSavedMap,
  onClose,
}: MapsPanelProps) {
  const split = useSplitLayout();
  const gameKey = `${game}\n${platform}`;
  const paneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrongGameRef = useRef<HTMLButtonElement>(null);
  const pickerBackRef = useRef<HTMLButtonElement>(null);

  const [menuId, setMenuId] = useState<string | null>(null);
  const [offlineNoticeId, setOfflineNoticeId] = useState<string | null>(null);
  const [cachedByProxy, setCachedByProxy] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState(() =>
    rememberedFilter?.key === gameKey ? rememberedFilter.query : "",
  );
  const [vg, setVg] = useState<VgState>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const [notFoundQuery, setNotFoundQuery] = useState("");
  const [picker, setPicker] = useState<PickerState>({
    status: "idle",
    since: 0,
    query: "",
    submitted: "",
    results: [],
  });
  // Row the viewer was opened from; outlined once the viewer closes.
  const [returnedKey, setReturnedKey] = useState<string | null>(null);

  const vgRef = useRef(vg);
  vgRef.current = vg;
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const lastEntryRef = useRef<VGMapsGameEntry | null>(null);
  const autoKeyRef = useRef<string | null>(null);
  const prevGameKeyRef = useRef(gameKey);
  const pickerAbortRef = useRef<AbortController | null>(null);
  const listScrollTopRef = useRef(0);
  const openedRowRef = useRef<string | null>(null);

  const stopLoading = useCallback((canceled: boolean) => {
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const running = vgRef.current;
    setVg({
      kind: "error",
      reason: canceled ? "canceled" : "unreachable",
      entry: running.kind === "loading" ? running.entry : undefined,
    });
  }, []);

  /** Run the VGMaps calls: search (unless the game entry is known), then the map list. */
  const startVgmaps = useCallback(
    (opts: { entry?: VGMapsGameEntry; query?: string } = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const gen = ++genRef.current;
      const current = () => gen === genRef.current;

      let entry = opts.entry;
      void (async () => {
        try {
          if (!entry) {
            const raw = opts.query?.trim() || defaultMapsQuery(game, platform);
            const parsed = opts.query
              ? parseMapsSearchQuery(raw, game, platform)
              : { game: game.trim(), platform: platform.trim() };
            setVg({ kind: "loading", stage: "search", since: Date.now() });
            const params = new URLSearchParams({ game: parsed.game });
            if (parsed.platform) params.set("platform", parsed.platform);
            const data = await fetchJson<{ games?: VGMapsGameEntry[] }>(
              `/api/maps/search?${params.toString()}`,
              controller.signal,
            );
            if (!current()) return;
            const decision = resolveMapsGame(
              parsed.game,
              parsed.platform,
              Array.isArray(data.games) ? data.games : [],
            );
            if (decision.type === "none") {
              // Show what was actually searched: the typed text, or the game name alone.
              const shown = opts.query ? raw : parsed.game;
              setNotFoundQuery(shown);
              setVg({ kind: "notfound", query: shown });
              return;
            }
            if (decision.type === "pick") {
              setVg({ kind: "pick", options: decision.options });
              return;
            }
            entry = decision.entry;
          }
          lastEntryRef.current = entry;
          setVg({ kind: "loading", stage: "list", entry, since: Date.now() });
          const params = new URLSearchParams({ url: entry.url });
          const data = await fetchJson<{ maps?: VGMapsMapLink[] }>(
            `/api/maps/list?${params.toString()}`,
            controller.signal,
          );
          if (!current()) return;
          setVg({ kind: "done", entry, maps: Array.isArray(data.maps) ? data.maps : [] });
        } catch (err) {
          // A newer run, Cancel or the timeout already set the state (and aborted this one).
          if (!current()) return;
          if (!entry) {
            setVg({ kind: "error", reason: "unreachable" });
            return;
          }
          const failure = mapsListFailure(err instanceof MapsHttpError ? err.status : null);
          if (failure.forgetChoice) {
            // The page is gone: never auto-load this entry again; Try again searches fresh.
            forgetChoice(game, platform);
            lastEntryRef.current = null;
          }
          setVg({ kind: "error", reason: failure.reason, entry });
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      })();
    },
    [game, platform],
  );

  const chooseGame = useCallback(
    (entry: VGMapsGameEntry) => {
      writeChoice(game, platform, entry);
      startVgmaps({ entry });
    },
    [game, platform, startVgmaps],
  );

  // Game switched while the panel is open (split mode): fresh list, filter cleared,
  // in-flight requests aborted.
  useEffect(() => {
    if (prevGameKeyRef.current === gameKey) return;
    prevGameKeyRef.current = gameKey;
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    pickerAbortRef.current?.abort();
    lastEntryRef.current = null;
    autoKeyRef.current = null;
    rememberedFilter = null;
    setFilter("");
    setVg({ kind: "idle" });
    setMenuId(null);
    setOfflineNoticeId(null);
    setReturnedKey(null);
    if (pickerOpen) onClosePicker();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [gameKey, pickerOpen, onClosePicker]);

  // Load the VGMaps list on open, on game change and when the connection comes back.
  useEffect(() => {
    if (!online || !game.trim()) return;
    const kind = vgRef.current.kind;
    if (autoKeyRef.current === gameKey && kind !== "idle" && kind !== "error") return;
    // Retry automatically after an offline error, never after an explicit Cancel.
    if (
      autoKeyRef.current === gameKey &&
      kind === "error" &&
      (vgRef.current as { reason: string }).reason !== "unreachable"
    ) {
      return;
    }
    autoKeyRef.current = gameKey;
    const remembered = readChoice(game, platform);
    startVgmaps(remembered ? { entry: remembered } : {});
  }, [gameKey, game, platform, online, startVgmaps]);

  // Abort everything on unmount (closing the panel never stops a map save, those are page-level).
  useEffect(
    () => () => {
      genRef.current += 1;
      abortRef.current?.abort();
      pickerAbortRef.current?.abort();
      autoKeyRef.current = null;
    },
    [],
  );

  // Slow notice after 6s without progress, give up at 20s.
  const loadingSince = vg.kind === "loading" ? vg.since : null;
  useEffect(() => {
    if (loadingSince === null) return;
    const timeout = setTimeout(
      () => stopLoading(false),
      Math.max(0, loadingSince + MAPS_TIMEOUT_MS - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [loadingSince, stopLoading]);

  // A clock for the slow notices (main list and picker search), only while one runs.
  const ticking = loadingSince !== null || (pickerOpen && picker.status === "loading");
  useEffect(() => {
    if (!ticking) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [ticking]);

  // Focus close button on open and restore focus to the invoking control on close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      const target =
        trigger && trigger !== document.body && document.contains(trigger)
          ? trigger
          : (document.querySelector<HTMLElement>(".game-card-maps") ??
            document.querySelector<HTMLElement>(".composer-extras"));
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

  // Esc: close row menu first, else close the whole panel (split: only when focus is inside).
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

  // Cache API presence for every saved map in the current game.
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

  useEffect(() => {
    if (online) setOfflineNoticeId(null);
  }, [online]);

  // Back from the viewer: focus the row it was opened from and outline it briefly
  // (reduced motion: a steady left rule until the next interaction).
  const prevViewerOpenRef = useRef(viewerOpen);
  useEffect(() => {
    const was = prevViewerOpenRef.current;
    prevViewerOpenRef.current = viewerOpen;
    const key = openedRowRef.current;
    if (!was || viewerOpen || !key) return;
    const row = paneRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
    row?.focus();
    setReturnedKey(key);
    if (prefersReducedMotion()) return;
    const timer = setTimeout(() => setReturnedKey(null), 1200);
    return () => clearTimeout(timer);
  }, [viewerOpen]);

  useEffect(() => {
    if (!returnedKey || !prefersReducedMotion()) return;
    const pane = paneRef.current;
    if (!pane) return;
    let armed = false;
    // Skip the focus/keyup that brought us back; the next real interaction clears it.
    const arm = setTimeout(() => {
      armed = true;
    }, 300);
    const clear = (event: Event) => {
      // Autofill and automation send keydown "Unidentified"; that isn't the player.
      if ((event as globalThis.KeyboardEvent).key === "Unidentified") return;
      if (armed) setReturnedKey(null);
    };
    pane.addEventListener("pointerdown", clear);
    pane.addEventListener("keydown", clear);
    return () => {
      clearTimeout(arm);
      pane.removeEventListener("pointerdown", clear);
      pane.removeEventListener("keydown", clear);
    };
  }, [returnedKey]);

  // Picker view: search prefilled with "game platform" when it opens; list scroll restored
  // and focus back on "Wrong game?" when it closes.
  const runPickerSearch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      pickerAbortRef.current?.abort();
      const controller = new AbortController();
      pickerAbortRef.current = controller;
      setPicker((prev) => ({ ...prev, status: "loading", since: Date.now(), submitted: trimmed }));
      try {
        const parsed = parseMapsSearchQuery(trimmed, game, platform);
        const params = new URLSearchParams({ game: parsed.game });
        if (parsed.platform) params.set("platform", parsed.platform);
        const timeout = setTimeout(() => controller.abort(), MAPS_TIMEOUT_MS);
        try {
          const data = await fetchJson<{ games?: VGMapsGameEntry[] }>(
            `/api/maps/search?${params.toString()}`,
            controller.signal,
          );
          if (pickerAbortRef.current !== controller) return;
          setPicker((prev) => ({
            ...prev,
            status: "done",
            results: Array.isArray(data.games) ? data.games : [],
          }));
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        if (pickerAbortRef.current !== controller) return;
        setPicker((prev) => ({ ...prev, status: "error", results: [] }));
      }
    },
    [game, platform],
  );

  const prevPickerOpenRef = useRef(pickerOpen);
  useEffect(() => {
    const was = prevPickerOpenRef.current;
    prevPickerOpenRef.current = pickerOpen;
    if (pickerOpen && !was) {
      const query = defaultMapsQuery(game, platform);
      setPicker({ status: "idle", since: 0, query, submitted: "", results: [] });
      if (online) void runPickerSearch(query);
      requestAnimationFrame(() => pickerBackRef.current?.focus());
    } else if (!pickerOpen && was) {
      pickerAbortRef.current?.abort();
      pickerAbortRef.current = null;
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = listScrollTopRef.current;
        (wrongGameRef.current ?? closeRef.current)?.focus();
      });
    }
  }, [pickerOpen, game, platform, online, runPickerSearch]);

  function openPicker() {
    listScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
    setMenuId(null);
    onOpenPicker();
  }

  function pickFromPicker(entry: VGMapsGameEntry) {
    chooseGame(entry);
    onClosePicker();
  }

  function retryVgmaps() {
    const entry = lastEntryRef.current;
    startVgmaps(entry ? { entry } : {});
  }

  function cancelPickerSearch() {
    pickerAbortRef.current?.abort();
    pickerAbortRef.current = null;
    setPicker((prev) => ({ ...prev, status: "canceled", results: [] }));
  }

  function updateFilter(next: string) {
    setFilter(next);
    rememberedFilter = { key: gameKey, query: next };
  }

  function handleOpenSavedRow(item: SavedMap) {
    setMenuId(null);
    const proxyUrl = mapProxyUrl(item.imageUrl, item.sourceUrl);
    const open = () => {
      setOfflineNoticeId(null);
      openedRowRef.current = `saved:${item.id}`;
      onOpenSavedMap(item);
    };
    if (!online && !(cachedByProxy[proxyUrl] ?? false)) {
      if (!(proxyUrl in cachedByProxy)) {
        void hasCachedMap(proxyUrl).then((cached) => {
          if (!cached) setOfflineNoticeId(item.id);
          else open();
        });
        return;
      }
      setOfflineNoticeId(item.id);
      return;
    }
    open();
  }

  function handleOpenFindRow(entry: VGMapsGameEntry, mapLink: VGMapsMapLink) {
    openedRowRef.current = `vg:${mapLink.imageUrl}`;
    onOpenFindMap(entry, mapLink, findSaved(game, mapLink.imageUrl));
  }

  function handleNotFoundSubmit(event: FormEvent) {
    event.preventDefault();
    if (!notFoundQuery.trim() || !online) return;
    startVgmaps({ query: notFoundQuery });
  }

  function handlePickerSubmit(event: FormEvent) {
    event.preventDefault();
    if (!online) return;
    void runPickerSearch(picker.query);
  }

  const vgMaps = vg.kind === "done" ? vg.maps : [];
  const filtered = filterMapsSections({ saved: savedItems, vgmaps: vgMaps, query: filter });
  const headerSub = [game, platform].filter(Boolean).join(" · ");

  function renderStage(state: Extract<VgState, { kind: "loading" }>) {
    const stage = mapsLoadStage(state.stage, {
      gameTitle: state.entry?.title,
      elapsedMs: Math.max(0, now - state.since),
    });
    return (
      <div className="maps-stage" role="status" aria-live="polite">
        <div className="maps-stage-track" aria-hidden="true">
          <div className="maps-stage-fill" style={{ transform: `scaleX(${stage.ratio})` }} />
        </div>
        <p className="maps-stage-text">{stage.text}</p>
        {stage.slow && (
          <div className="maps-stage-slow">
            <p className="maps-state-text">VGMaps is slow right now. Still trying…</p>
            <button type="button" className="maps-text-btn" onClick={() => stopLoading(true)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderGameOptions(options: VGMapsGameEntry[], onPick: (entry: VGMapsGameEntry) => void) {
    return (
      <ul className="maps-list">
        {options.map((entry) => (
          <li key={entry.url}>
            <button type="button" className="maps-row-open maps-game-row" onClick={() => onPick(entry)}>
              <strong className="saved-row-title">{entry.title}</strong>
              <span className="map-meta">{entry.platform}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  /** "Game on VGMaps: X. Wrong game?" for the entry a list (or a failed list) used. */
  function renderGameContext(entry: VGMapsGameEntry) {
    return (
      <p className="meta-text maps-context">
        Game on VGMaps: <strong>{entry.title}</strong>
        {entry.platform && !squash(entry.title).includes(squash(entry.platform))
          ? ` (${entry.platform})`
          : ""}
        .{" "}
        <button ref={wrongGameRef} type="button" className="maps-link-btn" onClick={openPicker}>
          Wrong game?
        </button>
      </p>
    );
  }

  function renderVgBody() {
    if (!online) {
      return (
        <div className="maps-state-block" role="status">
          <p className="maps-state-text">Offline. VGMaps search needs a connection.</p>
        </div>
      );
    }
    switch (vg.kind) {
      case "idle":
        return null;
      case "loading":
        return renderStage(vg);
      case "error":
        return (
          <>
            {vg.entry && renderGameContext(vg.entry)}
            <div className="maps-state-block" role="status">
              {vg.reason === "missing" ? (
                <p className="maps-state-text">
                  VGMaps no longer has a page for this game. Search again or pick another.
                </p>
              ) : vg.reason === "canceled" ? (
                <p className="maps-state-text">
                  {vg.entry ? "Loading canceled." : "Search canceled."}
                </p>
              ) : (
                <p className="maps-state-error">Couldn&apos;t reach VGMaps.</p>
              )}
              <button type="button" className="maps-btn-secondary" onClick={retryVgmaps}>
                {vg.reason === "missing" ? "Search again" : "Try again"}
              </button>
            </div>
          </>
        );
      case "pick":
        return (
          <div className="maps-pick">
            <p className="maps-state-text maps-pick-head">Which game?</p>
            {renderGameOptions(vg.options, chooseGame)}
          </div>
        );
      case "notfound":
        return (
          <div className="maps-state-block" role="status">
            <p className="maps-state-text">
              No game found on VGMaps for &ldquo;{vg.query}&rdquo;.
            </p>
            <form className="maps-search-form" onSubmit={handleNotFoundSubmit}>
              <div className="field-clear-wrap maps-search-field">
                <input
                  type="search"
                  className="maps-input"
                  aria-label="Game title on VGMaps"
                  value={notFoundQuery}
                  onChange={(event) => setNotFoundQuery(event.target.value)}
                />
                <ClearButton
                  show={Boolean(notFoundQuery)}
                  label="Clear search"
                  onClear={() => setNotFoundQuery("")}
                />
              </div>
              <button type="submit" className="maps-btn-secondary" disabled={!notFoundQuery.trim()}>
                Search again
              </button>
            </form>
          </div>
        );
      case "done":
        return (
          <>
            {renderGameContext(vg.entry)}
            {vg.maps.length === 0 ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-text">VGMaps lists this game but no maps.</p>
              </div>
            ) : (
              <ul className="maps-list">
                {filtered.vgmaps.map((mapLink) => renderFindRow(vg.entry, mapLink))}
              </ul>
            )}
          </>
        );
    }
  }

  function renderFindRow(entry: VGMapsGameEntry, mapLink: VGMapsMapLink) {
    const saved = findSaved(game, mapLink.imageUrl);
    const rowKey = `vg:${mapLink.imageUrl}`;
    const progress = saveProgress[mapLink.imageUrl] ?? null;
    const ref: MapRef = { imageUrl: mapLink.imageUrl, sourceUrl: entry.url };
    const overLimit = isMapOverLimit(mapLink);
    return (
      <li
        key={mapLink.imageUrl}
        className={`maps-row${returnedKey === rowKey ? " is-returned" : ""}`}
      >
        <button
          type="button"
          className="maps-row-open"
          data-row-key={rowKey}
          onClick={() => handleOpenFindRow(entry, mapLink)}
        >
          <strong className="saved-row-title">{mapLink.mapName}</strong>
          <span className="map-meta">
            {progress ? formatSavingText(progress) : formatFindMapMeta(mapLink, { saved: Boolean(saved) })}
          </span>
          {overLimit ? (
            <span className="maps-row-note">{formatVeryLargeRow(mapLink.fileSizeBytes)}</span>
          ) : mapLink.isLarge && !saved ? (
            <span className="map-meta-warn">
              Large file, {mapLink.fileSize || "over 6 MB"}. May take a while on mobile data.
            </span>
          ) : null}
        </button>
        {progress && (
          <div className="maps-row-progress">
            <div className="maps-progress-track" aria-hidden="true">
              <div
                className="maps-progress-fill"
                style={{ transform: `scaleX(${downloadProgressRatio(progress)})` }}
              />
            </div>
            <button
              type="button"
              className="maps-text-btn"
              aria-label={`Cancel saving ${mapLink.mapName}`}
              onClick={() => onCancelSave(ref)}
            >
              Cancel
            </button>
          </div>
        )}
      </li>
    );
  }

  function renderSavedRow(item: SavedMap) {
    const proxyUrl = mapProxyUrl(item.imageUrl, item.sourceUrl);
    const cached = proxyUrl in cachedByProxy ? cachedByProxy[proxyUrl] : null;
    const meta = formatSavedMapMeta(item, { cached, signedIn, syncAvailable, syncFailed });
    const rowKey = `saved:${item.id}`;
    return (
      <li
        key={item.id}
        className={`maps-row maps-row--saved${returnedKey === rowKey ? " is-returned" : ""}`}
      >
        <button
          type="button"
          className="maps-row-open"
          data-row-key={rowKey}
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
            onClick={() => setMenuId((id) => (id === item.id ? null : item.id))}
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
  }

  const noMatches = filtered.filtering && filtered.shown === 0 && filtered.total > 0;

  return (
    <>
      <button
        type="button"
        className="library-backdrop open saved-backdrop maps-backdrop"
        aria-label="Close maps"
        tabIndex={-1}
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
        <div className="maps-head">
          <span className="maps-head-title">
            Maps
            {headerSub && <small className="maps-head-game">{headerSub}</small>}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="sidebar-close maps-close"
            aria-label="Close maps"
            onClick={onClose}
          >
            <IconX />
          </button>
        </div>

        {pickerOpen ? (
          <div className="maps-scroll maps-picker">
            <button
              ref={pickerBackRef}
              type="button"
              className="maps-back-btn"
              onClick={onClosePicker}
            >
              <IconArrowLeft size={18} />
              <span>Back to maps</span>
            </button>
            <form className="maps-search-form" onSubmit={handlePickerSubmit}>
              <div className="field-clear-wrap maps-search-field">
                <input
                  type="search"
                  className="maps-input"
                  aria-label="Search VGMaps"
                  placeholder="Game title"
                  value={picker.query}
                  disabled={!online}
                  onChange={(event) => setPicker((prev) => ({ ...prev, query: event.target.value }))}
                />
                <ClearButton
                  show={Boolean(picker.query)}
                  disabled={!online}
                  label="Clear search"
                  onClear={() => setPicker((prev) => ({ ...prev, query: "" }))}
                />
              </div>
              <button
                type="submit"
                className="maps-btn-secondary"
                disabled={!online || !picker.query.trim() || picker.status === "loading"}
              >
                Search
              </button>
            </form>
            {!online ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-text">Offline. VGMaps search needs a connection.</p>
              </div>
            ) : picker.status === "loading" ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-text">Searching VGMaps…</p>
                {now - picker.since >= MAPS_SLOW_MS && (
                  <div className="maps-stage-slow">
                    <p className="maps-state-text">VGMaps is slow right now. Still trying…</p>
                    <button type="button" className="maps-text-btn" onClick={cancelPickerSearch}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : picker.status === "canceled" ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-text">Search canceled.</p>
                <button
                  type="button"
                  className="maps-btn-secondary"
                  onClick={() => void runPickerSearch(picker.query)}
                >
                  Try again
                </button>
              </div>
            ) : picker.status === "error" ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-error">Couldn&apos;t reach VGMaps.</p>
                <button
                  type="button"
                  className="maps-btn-secondary"
                  onClick={() => void runPickerSearch(picker.query)}
                >
                  Try again
                </button>
              </div>
            ) : picker.status === "done" && picker.results.length === 0 ? (
              <div className="maps-state-block" role="status">
                <p className="maps-state-text">
                  No game found on VGMaps for &ldquo;{picker.submitted}&rdquo;.
                </p>
              </div>
            ) : picker.status === "done" ? (
              renderGameOptions(picker.results, pickFromPicker)
            ) : null}
          </div>
        ) : (
          <>
            <div className="maps-filter">
              <div className="field-clear-wrap maps-search-field">
                <input
                  type="search"
                  className="maps-input"
                  aria-label="Filter maps"
                  placeholder="Filter maps"
                  value={filter}
                  onChange={(event) => updateFilter(event.target.value)}
                />
                <ClearButton
                  show={Boolean(filter)}
                  label="Clear filter"
                  onClear={() => updateFilter("")}
                />
              </div>
              <p className="maps-filter-count" role="status" aria-live="polite">
                {filtered.countText}
              </p>
            </div>

            <div ref={scrollRef} className="maps-scroll">
              {!online && savedItems.length > 0 && (
                <p className="saved-offline">Offline, showing what&apos;s on this device</p>
              )}

              {filtered.saved.length > 0 && (
                <section className="maps-section" aria-labelledby="maps-saved-head">
                  <h3 id="maps-saved-head" className="maps-section-head">
                    Saved on this device · {filtered.saved.length}
                  </h3>
                  <ul className="maps-list">{filtered.saved.map(renderSavedRow)}</ul>
                </section>
              )}

              {noMatches ? (
                <div className="maps-state-block" role="status">
                  <p className="maps-state-text">No maps match &ldquo;{filter.trim()}&rdquo;.</p>
                  <button type="button" className="maps-link-btn" onClick={() => updateFilter("")}>
                    Clear filter
                  </button>
                </div>
              ) : null}

              <section className="maps-section" aria-labelledby="maps-vg-head">
                <h3 id="maps-vg-head" className="maps-section-head">
                  On VGMaps{online && vg.kind === "done" ? ` · ${filtered.vgmaps.length}` : ""}
                </h3>
                {renderVgBody()}
              </section>
            </div>
          </>
        )}
      </section>
    </>
  );
}
