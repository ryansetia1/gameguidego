"use client";

import { useState } from "react";

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
  selectionLocked?: boolean;
  onSkipPage?: (slug: string) => void;
  onUnskipPage?: (slug: string) => void;
  onSkipAllMissing?: () => void;
  onRetryMissing?: () => void;
  onRefreshList?: () => void;
  retrying?: boolean;
  refreshingList?: boolean;
};

const MISSING_PREVIEW = 4;

function dotLabel(state: BundleIndexRow["state"]) {
  if (state === "indexed") return "Indexed";
  if (state === "skipped") return "Skipped";
  return "Not indexed";
}

function PageRow({
  row,
  onSkipPage,
  onUnskipPage,
}: {
  row: BundleIndexRow;
  onSkipPage?: (slug: string) => void;
  onUnskipPage?: (slug: string) => void;
}) {
  return (
    <li className={`bundle-index-row is-${row.state}`}>
      <span className="bundle-index-dot" aria-hidden="true" title={dotLabel(row.state)} />
      <span className="bundle-index-title">
        {row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer">
            {row.title}
          </a>
        ) : (
          <span className="bundle-index-name">{row.title}</span>
        )}
        {row.state === "indexed" && row.chunks ? (
          <span className="bundle-index-meta">{row.chunks} chunks</span>
        ) : null}
      </span>
      {row.state === "missing" && onSkipPage ? (
        <button
          type="button"
          className="bundle-index-skip"
          onClick={() => onSkipPage(row.slug)}
          aria-label={`Skip ${row.title}`}
        >
          Skip
        </button>
      ) : null}
      {row.state === "skipped" && onUnskipPage ? (
        <button
          type="button"
          className="bundle-index-skip"
          onClick={() => onUnskipPage(row.slug)}
          aria-label={`Include ${row.title}`}
        >
          Include
        </button>
      ) : null}
    </li>
  );
}

export function BundleIndexPanel({
  discoveredPages,
  indexedPages,
  missingPages = [],
  skippedSlugs = [],
  selectionLocked = false,
  onSkipPage,
  onUnskipPage,
  onSkipAllMissing,
  onRetryMissing,
  onRefreshList,
  retrying = false,
  refreshingList = false,
}: Props) {
  const [showAllMissing, setShowAllMissing] = useState(false);

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
  const indexedRows = rows.filter((row) => row.state === "indexed");
  const progressPct = targetTotal > 0 ? Math.round((indexedCount / targetTotal) * 100) : 0;
  const busy = retrying || refreshingList;
  const visibleMissing =
    showAllMissing || missingRows.length <= MISSING_PREVIEW
      ? missingRows
      : missingRows.slice(0, MISSING_PREVIEW);
  const hiddenMissingCount = missingRows.length - visibleMissing.length;

  return (
    <details className="bundle-index-panel">
      <summary className="bundle-index-summary">
        <span
          className="bundle-index-progress"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${indexedCount} of ${targetTotal} pages indexed`}
        >
          <span className="bundle-index-progress-fill" style={{ width: `${progressPct}%` }} />
        </span>
        <span className="bundle-index-summary-text">
          <strong>
            {indexedCount}/{targetTotal}
          </strong>{" "}
          indexed
          {selectionLocked ? <span className="bundle-index-tag">your pick</span> : null}
          {missingRows.length > 0 ? (
            <span className="bundle-index-pending"> · {missingRows.length} pending</span>
          ) : null}
          {skippedRows.length > 0 ? (
            <span className="bundle-index-muted"> · {skippedRows.length} skipped</span>
          ) : null}
        </span>
      </summary>

      <div className="bundle-index-body">
        {missingRows.length > 0 ? (
          <div className="bundle-index-section bundle-index-section--alert">
            <div className="bundle-index-toolbar">
              {onRetryMissing ? (
                <button
                  type="button"
                  className="bundle-index-btn bundle-index-btn--primary"
                  disabled={busy}
                  onClick={onRetryMissing}
                >
                  {retrying ? "Retrying…" : "Retry"}
                </button>
              ) : null}
              {onSkipAllMissing ? (
                <button
                  type="button"
                  className="bundle-index-btn"
                  disabled={busy}
                  onClick={onSkipAllMissing}
                >
                  Ignore all
                </button>
              ) : null}
            </div>
            <ul className="bundle-index-list">
              {visibleMissing.map((row) => (
                <PageRow
                  key={row.slug || row.url}
                  row={row}
                  onSkipPage={onSkipPage}
                />
              ))}
            </ul>
            {hiddenMissingCount > 0 ? (
              <button
                type="button"
                className="bundle-index-more"
                onClick={() => setShowAllMissing(true)}
              >
                Show {hiddenMissingCount} more
              </button>
            ) : null}
            {showAllMissing && missingRows.length > MISSING_PREVIEW ? (
              <button
                type="button"
                className="bundle-index-more"
                onClick={() => setShowAllMissing(false)}
              >
                Show less
              </button>
            ) : null}
          </div>
        ) : null}

        {indexedRows.length > 0 ? (
          <details className="bundle-index-subpanel">
            <summary>Indexed ({indexedRows.length})</summary>
            <ul className="bundle-index-list">
              {indexedRows.map((row) => (
                <PageRow key={row.slug || row.url} row={row} />
              ))}
            </ul>
          </details>
        ) : null}

        {skippedRows.length > 0 ? (
          <details className="bundle-index-subpanel">
            <summary>Skipped ({skippedRows.length})</summary>
            <ul className="bundle-index-list">
              {skippedRows.map((row) => (
                <PageRow
                  key={row.slug || row.url}
                  row={row}
                  onUnskipPage={onUnskipPage}
                />
              ))}
            </ul>
          </details>
        ) : null}

        {onRefreshList ? (
          <button
            type="button"
            className="bundle-index-refresh-link"
            disabled={busy}
            onClick={onRefreshList}
            title="Searches GameFAQs again for new sections (uses web search credits)."
          >
            {refreshingList ? "Refreshing page list…" : "Refresh page list"}
          </button>
        ) : null}
      </div>
    </details>
  );
}
