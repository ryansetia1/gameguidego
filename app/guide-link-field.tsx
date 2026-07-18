"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

type GuideHit = { title: string; url: string; snippet: string };

type Props = {
  value: string;
  onChange: (value: string) => void;
  game: string;
  platform: string;
  disabled?: boolean;
  /** Called when the user picks a result via "Use" — the caller collapses the section. */
  onGuidePicked?: () => void;
};

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function GuideLinkField({ value, onChange, game, platform, disabled, onGuidePicked }: Props) {
  const [mode, setMode] = useState<"link" | "search">("link");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GuideHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchAvailable, setSearchAvailable] = useState(true);
  const inputId = useId();
  const searchInputId = useId();
  const autoRanRef = useRef(false);
  const trimmedGame = game.trim();
  const canSearch = trimmedGame.length > 0;

  const runSearch = useCallback(async () => {
    if (!trimmedGame) {
      setSearchError("Enter a game name above first.");
      setResults([]);
      return;
    }

    setSearching(true);
    setSearchError("");
    try {
      const params = new URLSearchParams({ game: trimmedGame });
      if (platform.trim()) params.set("platform", platform.trim());
      const trimmedQuery = query.trim();
      if (trimmedQuery) params.set("q", trimmedQuery);

      const response = await fetch(`/api/guide-search?${params}`);
      const payload: { results?: GuideHit[]; available?: boolean } = await response.json();
      if (!response.ok) throw new Error("Search failed");

      setSearchAvailable(payload.available !== false);
      setResults(Array.isArray(payload.results) ? payload.results : []);
      if (payload.available === false) {
        setSearchError("Web search is not configured on this server.");
      } else if (!payload.results?.length) {
        setSearchError("No guides found. Try different keywords.");
      }
    } catch {
      setSearchError("Could not search right now. Try again or paste a link.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [trimmedGame, platform, query]);

  useEffect(() => {
    if (canSearch) return;
    setResults([]);
    setSearchError("");
  }, [canSearch]);

  useEffect(() => {
    autoRanRef.current = false;
  }, [trimmedGame, platform]);

  useEffect(() => {
    if (mode !== "search" || autoRanRef.current || disabled || !canSearch) return;
    autoRanRef.current = true;
    void runSearch();
  }, [mode, canSearch, disabled, runSearch]);

  function pickGuide(url: string) {
    onChange(url);
    setMode("link");
    setSearchError("");
    // The user has chosen their preferred guide — collapse the section.
    onGuidePicked?.();
  }

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <div className="guide-link-field">
      <div className="guide-link-modes" role="tablist" aria-label="Preferred guide source">
        <button
          type="button"
          role="tab"
          className={mode === "link" ? "active" : undefined}
          aria-selected={mode === "link"}
          disabled={disabled}
          onClick={() => setMode("link")}
        >
          Paste link
        </button>
        <button
          type="button"
          role="tab"
          className={mode === "search" ? "active" : undefined}
          aria-selected={mode === "search"}
          disabled={disabled}
          onClick={() => setMode("search")}
        >
          Search web
        </button>
      </div>

      {mode === "link" ? (
        <input
          id={inputId}
          type="url"
          inputMode="url"
          role="tabpanel"
          aria-label="Preferred guide URL"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste a specific guide page (not a category/hub) for best results"
          maxLength={300}
          autoComplete="off"
          disabled={disabled}
        />
      ) : (
        <div
          className={`guide-search-panel${canSearch ? "" : " is-inactive"}`}
          role="tabpanel"
          aria-label="Search web for a guide"
          aria-disabled={!canSearch || undefined}
        >
          <form className="guide-search-form" onSubmit={onSearchSubmit}>
            <input
              id={searchInputId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                canSearch
                  ? `Refine search for ${trimmedGame} (optional)`
                  : "Enter a game name above to search the web"
              }
              maxLength={120}
              autoComplete="off"
              readOnly={!canSearch}
              disabled={disabled || searching}
              tabIndex={canSearch ? undefined : -1}
            />
            {canSearch && (
              <button type="submit" className="nav-button" disabled={disabled || searching}>
                {searching ? "Searching…" : "Search"}
              </button>
            )}
          </form>
          {canSearch && (
            <p className="field-hint">
              Searching walkthrough sites for “{trimmedGame}”
              {platform ? ` on ${platform}` : ""}.
            </p>
          )}
          {searchError && canSearch && <p className="guide-search-error">{searchError}</p>}
          {results.length > 0 && searchAvailable && (
            <ul className="guide-search-results" aria-label="Guide search results">
              {results.map((hit) => (
                <li key={hit.url} className="guide-search-hit">
                  <div className="guide-search-hit-body">
                    <a href={hit.url} target="_blank" rel="noreferrer" className="guide-search-title">
                      {hit.title}
                    </a>
                    <span className="guide-search-host">{hostLabel(hit.url)}</span>
                    {hit.snippet && <p className="guide-search-snippet">{hit.snippet}</p>}
                  </div>
                  <button
                    type="button"
                    className="guide-search-use"
                    disabled={disabled}
                    onClick={() => pickGuide(hit.url)}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
