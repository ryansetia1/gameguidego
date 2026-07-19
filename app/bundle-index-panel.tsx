"use client";

export type BundleIndexRow = {
  slug: string;
  title: string;
  url: string;
  state: "indexed" | "missing" | "skipped";
  chunks?: number;
};

type Props = {
  discoveredPages: { slug: string; title: string; url: string }[];
  indexedPages: { slug: string; title: string; url: string; chunks: number }[];
  missingPages?: { slug: string; title: string; url: string }[];
  skippedSlugs?: string[];
  onSkipPage?: (slug: string) => void;
  onUnskipPage?: (slug: string) => void;
  onRetryMissing?: () => void;
  retrying?: boolean;
};

/** Shown while bundle preview + DB index status are still loading. */
export function BundleIndexPanelSkeleton() {
  return (
    <div
      className="bundle-index-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading guide index status"
    >
      <div className="bundle-index-skeleton-summary" />
      <ul className="bundle-index-skeleton-list" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <li
            key={index}
            className={`bundle-index-skeleton-row${index % 2 ? " short" : ""}`}
          />
        ))}
      </ul>
    </div>
  );
}

export function BundleIndexPanel({
  discoveredPages,
  indexedPages,
  missingPages = [],
  skippedSlugs = [],
  onSkipPage,
  onUnskipPage,
  onRetryMissing,
  retrying = false,
}: Props) {
  if (!discoveredPages.length && !indexedPages.length && !missingPages.length) {
    return null;
  }

  const skipped = new Set(skippedSlugs.map((slug) => slug.toLowerCase()));
  const indexedBySlug = new Map(indexedPages.map((page) => [page.slug, page]));
  const discoveredBySlug = new Map(discoveredPages.map((page) => [page.slug, page]));

  const slugOrder = [
    ...discoveredPages.map((page) => page.slug),
    ...missingPages.map((page) => page.slug).filter((slug) => !discoveredBySlug.has(slug)),
    ...indexedPages.map((page) => page.slug).filter(
      (slug) => !discoveredBySlug.has(slug) && !missingPages.some((p) => p.slug === slug),
    ),
  ];
  const uniqueSlugs = [...new Set(slugOrder)];

  const rows: BundleIndexRow[] = uniqueSlugs.map((slug) => {
    const discovered = discoveredBySlug.get(slug);
    const missing = missingPages.find((page) => page.slug === slug);
    const hit = indexedBySlug.get(slug);
    const title = discovered?.title ?? missing?.title ?? hit?.title ?? slug;
    const url = discovered?.url ?? missing?.url ?? hit?.url ?? "";
    let state: BundleIndexRow["state"] = "missing";
    if (hit) state = "indexed";
    else if (skipped.has(slug.toLowerCase())) state = "skipped";
    return {
      slug,
      title,
      url,
      state,
      chunks: hit?.chunks,
    };
  });

  const targetTotal = rows.filter((row) => row.state !== "skipped").length;
  const indexedCount = rows.filter((row) => row.state === "indexed").length;
  const missingRows = rows.filter((row) => row.state === "missing");
  const skippedRows = rows.filter((row) => row.state === "skipped");
  const sortedRows = [
    ...missingRows,
    ...skippedRows,
    ...rows.filter((row) => row.state === "indexed"),
  ];

  return (
    <details className="bundle-index-panel" open={missingRows.length > 0}>
      <summary>
        Indexed {indexedCount} of {targetTotal} pages
        {missingRows.length > 0 ? ` (${missingRows.length} not indexed)` : ""}
        {skippedRows.length > 0 ? ` · ${skippedRows.length} skipped` : ""}
      </summary>
      {missingRows.length > 0 && (
        <div className="bundle-index-missing-note">
          <p>
            Not indexed: {missingRows.map((row) => row.title).join(", ")}.
            {onRetryMissing ? " We retry these on your next question." : ""}
          </p>
          {onRetryMissing ? (
            <button
              type="button"
              className="bundle-index-retry"
              disabled={retrying}
              onClick={onRetryMissing}
            >
              {retrying ? "Retrying…" : "Retry missing pages"}
            </button>
          ) : null}
        </div>
      )}
      <ul className="bundle-index-list">
        {sortedRows.map((row) => (
          <li
            key={row.slug || row.url}
            className={`bundle-index-row is-${row.state}`}
          >
            <span
              className="bundle-index-dot"
              aria-hidden="true"
              title={
                row.state === "indexed"
                  ? "Indexed"
                  : row.state === "skipped"
                    ? "Skipped"
                    : "Not indexed"
              }
            />
            {row.url ? (
              <a href={row.url} target="_blank" rel="noreferrer">
                {row.title}
              </a>
            ) : (
              <span>{row.title}</span>
            )}
            <span className="bundle-index-status">
              {row.state === "indexed"
                ? "Indexed"
                : row.state === "skipped"
                  ? "Skipped"
                  : "Not indexed"}
            </span>
            {row.state === "indexed" && row.chunks ? (
              <span className="bundle-index-chunks">{row.chunks} chunks</span>
            ) : null}
            {row.state === "missing" && onSkipPage ? (
              <button
                type="button"
                className="bundle-index-skip"
                onClick={() => onSkipPage(row.slug)}
              >
                Skip
              </button>
            ) : null}
            {row.state === "skipped" && onUnskipPage ? (
              <button
                type="button"
                className="bundle-index-skip"
                onClick={() => onUnskipPage(row.slug)}
              >
                Include
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
