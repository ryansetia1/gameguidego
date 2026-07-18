"use client";

import { useCallback, useEffect, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import { IconX } from "./icons";

export type SteamGame = {
  appId: number;
  name: string;
  playtimeMinutes: number;
  cover: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (game: SteamGame) => void;
  /** Steam id (or user id) — namespaces the cache so accounts don't leak. */
  cacheKey?: string;
};

function formatPlaytime(minutes: number) {
  if (minutes < 60) return `${minutes}m played`;
  const hours = Math.round(minutes / 60);
  return `${hours}h played`;
}

// Best-effort localStorage cache so reopening the library is instant instead of
// re-hitting Steam every time. Stale-while-revalidate: show cached games, then
// refresh in the background. Keyed per account. 6h TTL.
const LIB_CACHE_KEY = "gg:steam-library";
const LIB_TTL = 6 * 60 * 60 * 1000;

function readLibCache(key: string): SteamGame[] | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const all = JSON.parse(window.localStorage.getItem(LIB_CACHE_KEY) || "{}");
    const hit = all[key];
    return hit && Date.now() - hit.ts < LIB_TTL ? (hit.games as SteamGame[]) : null;
  } catch {
    return null;
  }
}

function writeLibCache(key: string, games: SteamGame[]) {
  if (!key || typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(LIB_CACHE_KEY) || "{}");
    all[key] = { games, ts: Date.now() };
    window.localStorage.setItem(LIB_CACHE_KEY, JSON.stringify(all));
  } catch {
    // over quota / disabled — skip caching
  }
}

export function SteamLibrary({ open, onClose, onPick, cacheKey = "" }: Props) {
  const [games, setGames] = useState<SteamGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const loadLibrary = useCallback(
    async (showSpinner: boolean) => {
    const supabase = getSupabase();
    if (!supabase) {
      setError("Sign in to use your Steam library.");
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError("Sign in to use your Steam library.");
      return;
    }

    if (showSpinner) setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/steam/library", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload: {
        games?: SteamGame[];
        connected?: boolean;
        available?: boolean;
        error?: string;
      } = await response.json();

      if (!response.ok) throw new Error("Could not load Steam library");

      if (payload.available === false) {
        setError("Steam library is not configured on this server.");
        setGames([]);
        return;
      }

      if (!payload.connected) {
        setError("Connect Steam from the sidebar to import your games.");
        setGames([]);
        return;
      }

      const list = Array.isArray(payload.games) ? payload.games : [];
      setGames(list);
      if (list.length) writeLibCache(cacheKey, list);
      if (payload.error === "fetch_failed") {
        setError("Could not reach Steam right now. Try again in a moment.");
      } else if (!list.length) {
        setError(
          "No games found. Make sure your Steam profile and Game details are set to Public.",
        );
      }
    } catch {
      setError("Could not load Steam library.");
    } finally {
      setLoading(false);
    }
    },
    [cacheKey],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    // Show cached games instantly (no skeleton); always revalidate in the
    // background. First-ever open (no cache) shows the loading skeletons.
    const cached = readLibCache(cacheKey);
    if (cached) {
      setGames(cached);
      void loadLibrary(false);
    } else {
      setGames([]);
      void loadLibrary(true);
    }
  }, [open, loadLibrary, cacheKey]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const term = query.trim().toLowerCase();
  const filtered = term
    ? games.filter((game) => game.name.toLowerCase().includes(term))
    : games;

  return (
    <>
      <button
        type="button"
        className="library-backdrop open"
        aria-label="Close Steam library"
        onClick={onClose}
      />
      <div className="library open" role="dialog" aria-label="Steam library">
        <div className="library-panel">
          <div className="library-head">
            <span>Steam library</span>
            <button type="button" className="sidebar-close" aria-label="Close" onClick={onClose}>
              <IconX />
            </button>
          </div>
          {loading && games.length === 0 ? (
            <div className="library-grid" aria-label="Loading games" aria-busy="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="library-skeleton" aria-hidden="true">
                  <span className="library-skeleton-tile" />
                  <span className="library-skeleton-bar" />
                  <span className="library-skeleton-bar short" />
                </div>
              ))}
            </div>
          ) : error && games.length === 0 ? (
            <p className="library-empty">{error}</p>
          ) : (
            <>
              {games.length > 0 && (
                <div className="library-search-wrap">
                  <label className="library-search-label" htmlFor="steam-library-search">
                    Search
                  </label>
                  <input
                    id="steam-library-search"
                    type="search"
                    className="library-search"
                    placeholder="Search your games…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    autoComplete="off"
                    aria-label="Search Steam games"
                  />
                </div>
              )}
              {filtered.length === 0 ? (
                <p className="library-empty">No games match “{query.trim()}”.</p>
              ) : (
                <div className="library-grid">
                  {filtered.map((game) => (
                <button
                  key={game.appId}
                  type="button"
                  className="library-card"
                  onClick={() => onPick(game)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="cover-tile"
                    src={game.cover}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.visibility = "hidden";
                    }}
                  />
                  <strong>{game.name}</strong>
                  {game.playtimeMinutes > 0 && <small>{formatPlaytime(game.playtimeMinutes)}</small>}
                </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
