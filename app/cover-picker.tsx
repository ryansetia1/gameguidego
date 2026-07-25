"use client";

import { useEffect, useRef, useState } from "react";

import { ClearButton } from "./clear-button";
import { IconPlus, IconX } from "./icons";

type CoverGame = { id: number; name: string; year: string; cover: string; platform: string };

type Props = {
  initialQuery: string;
  onPick: (url: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
};

/**
 * Themed cover chooser: search TheGamesDB (same `/api/games` as game-name
 * autocomplete) and pick a box-art from a grid, or upload from device. Covers are
 * CDN URLs, so picking one costs no Storage; `resolveCoverUrl` passes them through.
 */
export function CoverPicker({ initialQuery, onPick, onUpload, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [games, setGames] = useState<CoverGame[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setGames([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/games?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        setAvailable(
          data && typeof data === "object" && "available" in data
            ? Boolean((data as { available: unknown }).available)
            : true,
        );
        const rows: CoverGame[] = Array.isArray(data?.games) ? data.games : [];
        // One tile per unique cover (drop same-art duplicates across platforms).
        const seen = new Set<string>();
        setGames(rows.filter((g) => g.cover && !seen.has(g.cover) && seen.add(g.cover)));
      } catch {
        // aborted or network error: keep the last grid
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div
      className="cover-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a cover"
      onClick={onClose}
    >
      <div className="cover-picker" onClick={(event) => event.stopPropagation()}>
        <div className="cover-picker-head">
          <strong>Choose a cover</strong>
          <button type="button" className="cover-picker-close" aria-label="Close" onClick={onClose}>
            <IconX size={20} />
          </button>
        </div>
        <div className="cover-picker-controls">
          <div className="field-clear-wrap cover-picker-search">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search game covers"
              aria-label="Search game covers"
            />
            <ClearButton show={query.length > 0} onClear={() => setQuery("")} />
          </div>
          <label className="cover-picker-upload icon-inline">
            <IconPlus /> Upload from device
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  onUpload(file);
                  onClose();
                }
              }}
            />
          </label>
        </div>
        {!available ? (
          <p className="cover-picker-msg">
            Cover search is off right now. You can still upload from your device.
          </p>
        ) : loading && games.length === 0 ? (
          <p className="cover-picker-msg">Searching…</p>
        ) : games.length > 0 ? (
          <div className="cover-picker-grid">
            {games.map((game) => (
              <button
                type="button"
                key={game.cover}
                className="cover-picker-tile"
                onClick={() => {
                  onPick(game.cover);
                  onClose();
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={game.cover}
                  alt={`${game.name} cover`}
                  loading="lazy"
                  onError={(event) => {
                    // Hide (don't .remove()) so React keeps owning the node —
                    // removing a keyed list child crashes reconciliation on the
                    // next search. display:none also drops it from the grid.
                    const tile = event.currentTarget.closest("button");
                    if (tile) tile.style.display = "none";
                  }}
                />
                <span>
                  {game.name}
                  {game.year ? ` (${game.year})` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="cover-picker-msg">
            {query.trim().length < 2
              ? "Type a game name to find covers."
              : "No covers found. Try a different name."}
          </p>
        )}
      </div>
    </div>
  );
}
