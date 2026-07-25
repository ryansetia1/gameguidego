import {
  bundleHasPendingPages,
  filterBundlePanelPages,
  getBundlePrefs,
} from "./bundle-prefs.js";
import { resolveGuideDisplayState } from "./guide-index-state";
import {
  guideUrlsSummary,
  isActiveGamefaqsBundle,
  isGamefaqsBundleUrl,
  isUploadedGuideUrl,
  uploadedGuideFileTypeLabel,
  uploadedGuideFilename,
} from "./guide-urls.js";

/** @param {string[]} urls @param {Record<string, import("../app/guide-link-field").GuideBundleMeta> | undefined} meta */
export function buildBundlePrefsBody(urls, meta) {
  /** @type {Record<string, { skipSlugs: string[]; includeSlugs?: string[] }>} */
  const out = {};
  for (const url of urls) {
    if (!isGamefaqsBundleUrl(url)) continue;
    const prefs = mergedBundlePrefs(url, meta?.[url]);
    out[url] = {
      skipSlugs: prefs.skippedSlugs,
      ...(prefs.selectedSlugs?.length ? { includeSlugs: prefs.selectedSlugs } : {}),
    };
  }
  return out;
}

/**
 * Slugs that no longer need an ingest attempt: already indexed, OR tried before and
 * recorded as failed (blocked / not found). Folding failures in here stops the
 * per-turn "memorizing" nag for pages that will never succeed.
 * @param {{ pages?: { slug: string }[]; failedPages?: { slug: string }[] } | undefined} indexStatus
 * @returns {string[]}
 */
export function settledBundleSlugs(indexStatus) {
  return [
    ...(indexStatus?.pages?.map((page) => page.slug) ?? []),
    ...(indexStatus?.failedPages?.map((page) => page.slug) ?? []),
  ];
}

/**
 * @param {string} url
 * @param {import("../app/guide-link-field").GuideBundleMeta | undefined} meta
 * @param {{ pages: { slug: string }[]; failedPages?: { slug: string }[] } | undefined} indexStatus
 * @param {string | undefined} indexState
 */
export function guideUrlNeedsIngest(url, meta, indexStatus, indexState) {
  if (indexState === "indexed") return false;
  const bundlePages = meta?.pageCount && meta.pageCount > 1;
  const discovered = meta?.pages ?? [];
  const indexedSlugs = settledBundleSlugs(indexStatus);
  const prefs = mergedBundlePrefs(url, meta);
  if (
    bundlePages &&
    discovered.length &&
    !bundleHasPendingPages(discovered, indexedSlugs, prefs)
  ) {
    return false;
  }
  return true;
}

/** @param {string} url @param {import("../app/guide-link-field").GuideBundleMeta | undefined} meta */
export function mergedBundlePrefs(url, meta) {
  const stored = getBundlePrefs(url);
  return {
    skippedSlugs: meta?.skippedSlugs ?? stored.skippedSlugs ?? [],
    selectedSlugs: meta?.selectedSlugs ?? stored.selectedSlugs,
  };
}

/**
 * @param {string} url
 * @param {import("../app/guide-link-field").GuideBundleMeta | undefined} meta
 * @param {{ meta: boolean; status: boolean } | undefined} load
 */
export function isBundlePanelLoading(url, meta, load) {
  if (!load) return true;
  const needMeta = !meta?.pages?.length;
  if (needMeta && !load.meta) return true;
  if (!load.status) return true;
  return false;
}

/**
 * @param {string} url
 * @param {import("../app/guide-link-field").GuideBundleMeta | undefined} meta
 * @param {{ pages: { slug: string; title: string; url: string; chunks: number }[] } | undefined} indexStatus
 * @param {{ meta: boolean; status: boolean } | undefined} panelLoad
 * @param {"unknown" | "checking" | "indexed" | "failed" | "blocked" | "unavailable" | "pending" | undefined} globalIndexState
 */
export function gameCardGuideRow(url, meta, indexStatus, panelLoad, globalIndexState) {
  const bundle = isActiveGamefaqsBundle(url, meta);
  const bundlePrefs = mergedBundlePrefs(url, meta);
  const uploaded = isUploadedGuideUrl(url);
  const label = bundle
    ? meta
      ? `${meta.title} (${bundlePrefs.selectedSlugs?.length ?? meta.pageCount} pages)`
      : "GameFAQs bundle"
    : uploaded
      ? `${uploadedGuideFileTypeLabel(url)} · ${uploadedGuideFilename(url)}`
      : meta?.title
        ? meta.title
        : guideUrlsSummary([url]);
  const selectionLocked = Boolean(bundlePrefs.selectedSlugs?.length);
  const discoveredPages = filterBundlePanelPages(
    meta?.pages?.map((page) => ({
      slug: page.slug,
      title: page.title,
      url: page.url,
    })) ?? [],
    bundlePrefs.selectedSlugs,
  );
  const indexedPages = filterBundlePanelPages(indexStatus?.pages ?? [], bundlePrefs.selectedSlugs);
  const skippedSlugs = meta?.skippedSlugs ?? getBundlePrefs(url).skippedSlugs ?? [];
  const skippedSet = new Set(skippedSlugs.map((slug) => slug.toLowerCase()));
  const missingPages = filterBundlePanelPages(
    (
      meta?.missingPages ??
      discoveredPages
        .filter((page) => !indexedPages.some((hit) => hit.slug === page.slug))
        .map((page) => ({
          slug: page.slug,
          title: page.title,
          url: page.url,
        }))
    ).filter((page) => !skippedSet.has(page.slug.toLowerCase())),
    bundlePrefs.selectedSlugs,
  );
  const panelLoading = bundle && isBundlePanelLoading(url, meta, panelLoad);
  const showPanel =
    discoveredPages.length > 0 ||
    indexedPages.length > 0 ||
    missingPages.length > 0 ||
    skippedSlugs.length > 0;

  let state = "pending";
  if (globalIndexState === "unavailable") {
    state = "unavailable";
  } else if (globalIndexState === "checking" || panelLoading) {
    state = "checking";
  } else if (bundle) {
    if (indexedPages.length > 0) {
      state = "indexed";
    } else if (missingPages.length > 0) {
      state = resolveGuideDisplayState(
        globalIndexState === "failed" ? "failed" : "pending",
        meta,
      );
    } else {
      state = resolveGuideDisplayState(globalIndexState, meta);
    }
  } else {
    state = resolveGuideDisplayState(globalIndexState, meta);
  }

  return {
    bundle,
    uploaded,
    label,
    selectionLocked,
    discoveredPages,
    indexedPages,
    missingPages,
    skippedSlugs,
    panelLoading,
    showPanel,
    state,
    isBlocked: meta?.isBlocked,
  };
}
