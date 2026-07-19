"use client";

import { FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import {
  MAX_GUIDE_URLS,
  cleanGuideUrl,
  guideUrlDedupeKey,
  isActiveGamefaqsBundle,
  isSamePreferredGuide,
  normalizeGuideUrlList,
  normalizePreferredGuideUrl,
} from "@/lib/guide-urls.js";
import { parseGamefaqsFaqUrl } from "@/lib/gamefaqs-bundle.js";
import { setBundlePrefs } from "@/lib/bundle-prefs.js";

type GuideHit = { title: string; url: string; snippet: string };

export type GuideBundleMeta = {
  title: string;
  pageCount: number;
  pages?: { slug: string; title: string; url: string }[];
  missingPages?: { slug: string; title: string; url: string }[];
  selectedSlugs?: string[];
  skippedSlugs?: string[];
};

type BundlePreview = {
  canonicalUrl: string;
  title: string;
  pageCount: number;
  pages: { slug: string; title: string; url: string }[];
};

type Props = {
  value: string[];
  onChange: (value: string[]) => void;
  game: string;
  platform: string;
  disabled?: boolean;
  bundleMeta?: Record<string, GuideBundleMeta>;
  onBundleMetaChange?: (meta: Record<string, GuideBundleMeta>) => void;
  onGuideCheckChange?: (checking: boolean) => void;
};

function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function GuideLinkField({
  value,
  onChange,
  game,
  platform,
  disabled,
  bundleMeta = {},
  onBundleMetaChange,
  onGuideCheckChange,
}: Props) {
  const [mode, setMode] = useState<"link" | "search">("link");
  const [draftUrl, setDraftUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [bundlePreview, setBundlePreview] = useState<BundlePreview | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(new Set());
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
  const atMax = value.length >= MAX_GUIDE_URLS;

  const commitAddUrl = useCallback(
    (raw: string, meta?: GuideBundleMeta) => {
      const cleaned = normalizePreferredGuideUrl(raw);
      if (!cleaned) {
        setAddError("Paste a full http or https link.");
        return false;
      }
      if (value.some((entry) => isSamePreferredGuide(entry, cleaned))) {
        setAddError("That guide is already in your list.");
        return false;
      }
      const next = normalizeGuideUrlList([...value, cleaned]);
      if (next.length > MAX_GUIDE_URLS) {
        setAddError(`You can add up to ${MAX_GUIDE_URLS} guides.`);
        return false;
      }
      onChange(next);
      if (meta && onBundleMetaChange) {
        onBundleMetaChange({ ...bundleMeta, [cleaned]: meta });
      }
      setDraftUrl("");
      setAddError("");
      setBundlePreview(null);
      return true;
    },
    [bundleMeta, onBundleMetaChange, onChange, value],
  );

  const previewGuideUrl = useCallback(async (raw: string) => {
    const cleaned = cleanGuideUrl(raw);
    if (!cleaned) {
      setAddError("Paste a full http or https link.");
      return;
    }
    if (value.some((entry) => isSamePreferredGuide(entry, cleaned))) {
      setAddError("That guide is already in your list.");
      return;
    }

    const parsed = parseGamefaqsFaqUrl(cleaned);
    const bundleUrl = parsed?.canonicalUrl ?? "";

    if (!parsed) {
      commitAddUrl(cleaned);
      return;
    }

    // FAQ root only (no chapter) — single-page until ingest/cache proves multi-page.
    if (!parsed.sectionSlug) {
      commitAddUrl(cleaned);
      return;
    }

    setPreviewLoading(true);
    setAddError("");
    setBundlePreview(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(
        `/api/guide-bundle?url=${encodeURIComponent(cleaned)}`,
        { signal: controller.signal },
      );
      const payload: {
        bundle?: boolean;
        canonicalUrl?: string;
        title?: string;
        pageCount?: number;
        pages?: { slug?: string; title: string; url: string }[];
        error?: string;
      } = await response.json();

      if (!response.ok) {
        setAddError(payload.error ?? "Couldn't check that link. Try again.");
        return;
      }

      if (
        payload.bundle &&
        payload.canonicalUrl &&
        typeof payload.pageCount === "number" &&
        payload.pageCount > 1 &&
        Array.isArray(payload.pages)
      ) {
        setBundlePreview({
          canonicalUrl: payload.canonicalUrl,
          title: payload.title ?? "GameFAQs guide",
          pageCount: payload.pageCount,
          pages: payload.pages.map((page) => ({
            slug:
              typeof page.slug === "string" && page.slug
                ? page.slug
                : page.url.split("/").pop() ?? "",
            title: page.title,
            url: page.url,
          })),
        });
        setSelectedSlugs(
          new Set(
            payload.pages.map((page) =>
              typeof page.slug === "string" && page.slug
                ? page.slug
                : page.url.split("/").pop() ?? "",
            ),
          ),
        );
        return;
      }

      commitAddUrl(bundleUrl);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      setAddError(
        timedOut
          ? "That took too long. Try again or paste a chapter link from the bundle."
          : "Couldn't check that link. Try again.",
      );
    } finally {
      window.clearTimeout(timeout);
      setPreviewLoading(false);
    }
  }, [commitAddUrl, value]);

  const removeUrl = useCallback(
    (url: string) => {
      onChange(value.filter((entry) => entry !== url));
      if (onBundleMetaChange && bundleMeta[url]) {
        const next = { ...bundleMeta };
        delete next[url];
        onBundleMetaChange(next);
      }
      setAddError("");
    },
    [bundleMeta, onBundleMetaChange, onChange, value],
  );

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
    onGuideCheckChange?.(previewLoading || Boolean(bundlePreview));
    return () => onGuideCheckChange?.(false);
  }, [previewLoading, bundlePreview, onGuideCheckChange]);

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

  function onAddSubmit(event: FormEvent) {
    event.preventDefault();
    void previewGuideUrl(draftUrl);
  }

  /** Paste link and Search web both route through previewGuideUrl. */
  function pickGuide(url: string) {
    if (atMax) {
      setSearchError(`You can add up to ${MAX_GUIDE_URLS} guides.`);
      return;
    }
    void previewGuideUrl(url);
  }

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
    void runSearch();
  }

  function confirmBundle() {
    if (!bundlePreview) return;
    const slugs = [...selectedSlugs];
    if (!slugs.length) {
      setAddError("Pick at least one page to index.");
      return;
    }
    const selectedPages = bundlePreview.pages.filter((page) =>
      selectedSlugs.has(page.slug),
    );
    setBundlePrefs(bundlePreview.canonicalUrl, {
      skippedSlugs: [],
      selectedSlugs: slugs,
    });
    commitAddUrl(bundlePreview.canonicalUrl, {
      title: bundlePreview.title,
      pageCount: selectedPages.length,
      pages: selectedPages,
      selectedSlugs: slugs,
      skippedSlugs: [],
    });
  }

  function toggleBundlePage(slug: string) {
    setSelectedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  const urlInList = (url: string) => {
    const cleaned = cleanGuideUrl(url);
    if (!cleaned) return false;
    return value.some((entry) => isSamePreferredGuide(entry, cleaned));
  };

  return (
    <div className="guide-link-field">
      <div className="guide-link-modes" role="tablist" aria-label="Preferred guide sources">
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

      {value.length > 0 && (
        <ul className="guide-url-list" aria-label="Added guides">
          {value.map((url) => {
            const meta = bundleMeta[url];
            const bundle = isActiveGamefaqsBundle(url, meta);
            return (
              <li key={guideUrlDedupeKey(url)} className="guide-url-row">
                <div className="guide-url-row-body">
                  <a href={url} target="_blank" rel="noreferrer" className="guide-url-host">
                    {bundle ? "GameFAQs bundle" : hostLabel(url)}
                  </a>
                  <span className="guide-url-path">
                    {bundle && meta
                      ? `${meta.title} · ${meta.pageCount} pages`
                      : url}
                  </span>
                </div>
                <button
                  type="button"
                  className="guide-url-remove"
                  disabled={disabled}
                  aria-label={`Remove ${bundle ? "bundle" : hostLabel(url)}`}
                  onClick={() => removeUrl(url)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {bundlePreview && (
        <div className="guide-bundle-preview" role="status" aria-live="polite">
          <p className="guide-bundle-preview-eyebrow">Multi-page GameFAQs guide</p>
          <h4 className="guide-bundle-preview-title">{bundlePreview.title}</h4>
          <p className="guide-bundle-preview-copy">
            Pick which pages to index. We&apos;ll fetch them the first time you ask
            a question. Large guides can take a few minutes.
          </p>
          <div className="guide-bundle-preview-select">
            <button
              type="button"
              onClick={() =>
                setSelectedSlugs(new Set(bundlePreview.pages.map((page) => page.slug)))
              }
            >
              Select all
            </button>
            <button type="button" onClick={() => setSelectedSlugs(new Set())}>
              Clear
            </button>
          </div>
          <ul className="guide-bundle-preview-pages">
            {bundlePreview.pages.map((page) => (
              <li key={page.url} className="guide-bundle-preview-page-row">
                <input
                  id={`bundle-page-${page.slug}`}
                  type="checkbox"
                  checked={selectedSlugs.has(page.slug)}
                  onChange={() => toggleBundlePage(page.slug)}
                />
                <label htmlFor={`bundle-page-${page.slug}`}>{page.title}</label>
              </li>
            ))}
          </ul>
          <div className="guide-bundle-preview-actions">
            <button
              type="button"
              className="nav-button"
              disabled={disabled}
              onClick={() => {
                setBundlePreview(null);
                setSelectedSlugs(new Set());
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="nav-button guide-bundle-preview-add"
              disabled={disabled || selectedSlugs.size === 0}
              onClick={confirmBundle}
            >
              Add bundle ({selectedSlugs.size} pages)
            </button>
          </div>
        </div>
      )}

      {mode === "link" ? (
        <form className="guide-url-add-form" onSubmit={onAddSubmit} role="tabpanel">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            aria-label="Guide URL to add"
            value={draftUrl}
            onChange={(event) => {
              setDraftUrl(event.target.value);
              if (addError) setAddError("");
              if (bundlePreview) setBundlePreview(null);
            }}
            placeholder={
              atMax
                ? `Up to ${MAX_GUIDE_URLS} guides added`
                : "Paste a GameFAQs or walkthrough link"
            }
            maxLength={300}
            autoComplete="off"
            disabled={disabled || atMax || previewLoading}
          />
          <button
            type="submit"
            className="nav-button"
            disabled={disabled || atMax || previewLoading || !draftUrl.trim()}
          >
            {previewLoading ? "Checking…" : "Add"}
          </button>
        </form>
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
              disabled={disabled || searching || previewLoading || Boolean(bundlePreview)}
              tabIndex={canSearch ? undefined : -1}
            />
            {canSearch && (
              <button type="submit" className="nav-button" disabled={disabled || searching}>
                {searching ? (
                  <span className="guide-search-busy">
                    <span className="guide-search-spinner loader" aria-hidden="true" />
                    Searching…
                  </span>
                ) : (
                  "Search"
                )}
              </button>
            )}
          </form>
          {canSearch && (
            <p className="field-hint guide-search-status" aria-live="polite">
              {searching && (
                <span className="guide-search-spinner loader" aria-hidden="true" />
              )}
              <span>
                Searching walkthrough sites for “{trimmedGame}”
                {platform ? ` on ${platform}` : ""}
                {searching ? "…" : "."}
              </span>
            </p>
          )}
          {searchError && canSearch && <p className="guide-search-error">{searchError}</p>}
          {results.length > 0 && searchAvailable && (
            <ul className="guide-search-results" aria-label="Guide search results">
              {results.map((hit) => {
                const added = urlInList(hit.url);
                return (
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
                      disabled={disabled || added || atMax || previewLoading}
                      onClick={() => pickGuide(hit.url)}
                    >
                      {added ? "Added" : previewLoading ? "Checking…" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <p className="field-hint">
        {atMax
          ? `${MAX_GUIDE_URLS} guides max. Remove one to add another.`
          : `Add up to ${MAX_GUIDE_URLS} trusted guides. Non-GameFAQs links add directly; GameFAQs chapter links open the page picker when we have a cached bundle.`}
      </p>
      {addError && <p className="guide-search-error">{addError}</p>}
    </div>
  );
}
