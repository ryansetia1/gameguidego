"use client";

import { useEffect, useRef, useState } from "react";

import { tgdbPlatformToLabel } from "@/lib/platforms.js";

import { ClearButton } from "./clear-button";
import { IconCheck } from "./icons";

type Game = {
  id: number;
  name: string;
  year: string;
  releaseDate?: string;
  cover: string;
  platform: string;
  hint?: string;
};

// Best-effort client cache of autocomplete results (24h) so repeat lookups don't
// spend TheGamesDB's monthly quota. In-memory Map mirrored to localStorage; any
// failure just falls through to the network. Only successful (available) results
// are cached, so a missing/broken key retries once fixed.
const CACHE_KEY = "gg:games-cache-v2";
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 200;

type CacheEntry = { games: Game[]; available: boolean; ts: number };

const memCache = new Map<string, CacheEntry>();
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded || typeof window === "undefined") return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "{}");
    for (const [key, value] of Object.entries(raw)) {
      memCache.set(key, value as CacheEntry);
    }
  } catch {
    // ignore corrupt cache
  }
}

function readCache(key: string): CacheEntry | null {
  loadCache();
  const hit = memCache.get(key);
  return hit && Date.now() - hit.ts < CACHE_TTL ? hit : null;
}

function writeCache(key: string, entry: CacheEntry) {
  memCache.set(key, entry);
  if (typeof window === "undefined") return;
  try {
    if (memCache.size > CACHE_MAX) {
      const excess = [...memCache.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, memCache.size - CACHE_MAX);
      for (const [old] of excess) memCache.delete(old);
    }
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(memCache)));
  } catch {
    // over quota / disabled storage — keep the in-memory copy only
  }
}

// Group results by their (mapped) platform label so a multi-console game lists
// one row per console under a header. Preserves first-seen order.
function groupByPlatform(results: Game[]) {
  const order: string[] = [];
  const groups = new Map<string, { game: Game; index: number }[]>();
  results.forEach((game, index) => {
    const label = tgdbPlatformToLabel(game.platform) || game.platform || "Other";
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push({ game, index });
  });
  return order.map((label) => ({ label, items: groups.get(label)! }));
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onPick?: (game: { name: string; year: string; cover: string; platform: string }) => void;
  showCover?: boolean;
  disabled?: boolean;
};

export function GameAutocomplete({
  value,
  onChange,
  onPick,
  showCover = true,
  disabled,
}: Props) {
  const [results, setResults] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Only real keystrokes trigger a lookup. Programmatic value changes (a picked
  // result, opening a saved chat, a Steam import) must not fetch or open the panel.
  const userTyped = useRef(false);

  useEffect(() => {
    const query = value.trim();
    if (!userTyped.current) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    userTyped.current = false;
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    // Serve repeat lookups from the client cache (no API call, saves quota).
    const cacheKey = query.toLowerCase();
    const cached = readCache(cacheKey);
    if (cached) {
      setResults(cached.games);
      setActive(-1);
      setOpen(cached.available);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/games?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const data: unknown = await response.json();
        const games =
          data &&
          typeof data === "object" &&
          "games" in data &&
          Array.isArray((data as { games: unknown }).games)
            ? ((data as { games: Game[] }).games)
            : [];
        const available =
          data && typeof data === "object" && "available" in data
            ? Boolean((data as { available: unknown }).available)
            : true;
        setResults(games);
        setActive(-1);
        setOpen(available);
        // Only cache real results so a missing/broken key retries once fixed.
        if (available) writeCache(cacheKey, { games, available, ts: Date.now() });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setResults([]);
          setOpen(false);
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function pick(game: Game) {
    onChange(game.name);
    onPick?.({
      name: game.name,
      year: game.year,
      cover: game.cover,
      platform: game.platform,
    });
    setResults([]);
    setOpen(false);
  }

  function commitTyped() {
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const query = value.trim();
    const showCustom = query.length >= 2;
    const resultOffset = showCustom ? 1 : 0;
    const lastIndex = resultOffset + results.length - 1;

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (!open || query.length < 2) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i < lastIndex ? i + 1 : i < 0 ? 0 : i));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i > 0 ? i - 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active === 0 && showCustom) commitTyped();
      else if (active >= resultOffset && results[active - resultOffset]) pick(results[active - resultOffset]);
      else commitTyped();
    }
  }

  const query = value.trim();
  const showPanel = open && query.length >= 2;
  const showCustom = query.length >= 2;
  const resultOffset = showCustom ? 1 : 0;
  const showCommit = query.length >= 3 && !loading && !disabled;
  const grouped = groupByPlatform(results);
  const showGroupHeaders = grouped.length > 1;

  return (
    <div
      className={`combo field-clear-wrap${showCommit ? " has-commit" : ""}`}
      ref={rootRef}
    >
      <input
        ref={inputRef}
        id="game"
        name="game"
        className={`combo-input${loading ? " loading" : ""}`}
        value={value}
        onChange={(event) => {
          userTyped.current = true;
          onChange(event.target.value);
        }}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder="e.g. The Legend of Zelda: Link's Awakening"
        maxLength={120}
        autoComplete="off"
        role="combobox"
        aria-expanded={showPanel}
        aria-autocomplete="list"
        disabled={disabled}
      />
      {loading && <span className="combo-spinner loader" aria-hidden="true" />}
      {showCommit && (
        <button
          type="button"
          className="field-commit"
          aria-label="Use typed game name"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            commitTyped();
            inputRef.current?.focus();
          }}
        >
          <IconCheck size={16} />
        </button>
      )}
      <ClearButton
        show={value.length > 0 && !loading && !disabled}
        onClear={() => {
          userTyped.current = true;
          onChange("");
          setOpen(false);
          inputRef.current?.focus();
        }}
        label="Clear game name"
      />
      {showPanel && (
        <div className="combo-panel">
          <ul className="combo-list" role="listbox">
            {loading && results.length === 0 && (
              <li className="combo-empty">Searching games...</li>
            )}
            {showCustom && !loading && (
              <li
                role="option"
                aria-selected={active === 0}
                className={`combo-option combo-option-custom${active === 0 ? " active" : ""}`}
                onMouseEnter={() => setActive(0)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commitTyped();
                }}
              >
                <span className="combo-name">
                  <span className="combo-title">Use &ldquo;{query}&rdquo;</span>
                  <span className="combo-hint">Keep what you typed</span>
                </span>
              </li>
            )}
            {!loading && results.length === 0 && !showCustom && (
              <li className="combo-empty">No matching games</li>
            )}
            {grouped.flatMap((group) => {
              const header = showGroupHeaders ? (
                <li key={`h-${group.label}`} className="combo-group-label" role="presentation">
                  {group.label}
                </li>
              ) : null;
              return [
                header,
                ...group.items.map(({ game, index }) => (
                  <li
                    key={game.id}
                    role="option"
                    aria-selected={index + resultOffset === active}
                    className={`combo-option${index + resultOffset === active ? " active" : ""}`}
                    onMouseEnter={() => setActive(index + resultOffset)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(game);
                    }}
                  >
                    {showCover &&
                      (game.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="combo-cover" src={game.cover} alt="" loading="lazy" />
                      ) : (
                        <span className="combo-cover combo-cover-empty" aria-hidden="true" />
                      ))}
                    <span className="combo-name">
                      <span className="combo-title">
                        {game.name}
                        {game.year && <span className="combo-year"> ({game.year})</span>}
                      </span>
                      {game.hint && <span className="combo-hint">{game.hint}</span>}
                    </span>
                  </li>
                )),
              ];
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
