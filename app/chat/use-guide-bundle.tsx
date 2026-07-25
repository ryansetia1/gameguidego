"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  filterBundlePanelPages,
  getBundlePrefs,
  hydrateBundlePrefsFromUser,
  registerBundlePrefsSync,
  skipAllMissingBundlePages,
  skipBundlePage,
  unskipBundlePage,
} from "@/lib/bundle-prefs.js";
import { guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import {
  buildBundlePrefsBody,
  mergedBundlePrefs,
} from "@/lib/guide-card-ui.js";
import {
  type GuideIndexState,
  guideIndexStateFromIngest,
} from "@/lib/guide-index-state";
import { isActiveGamefaqsBundle, isGamefaqsBundleUrl, isUploadedGuideUrl } from "@/lib/guide-urls.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import { getSupabase } from "@/lib/supabase";
import type { GuideBundleMeta } from "../guide-link-field";

export type { GuideIndexState } from "@/lib/guide-index-state";

export type UseGuideBundleOptions = {
  preferredUrls: string[];
  game: string;
  platform: string;
  user: User | null;
  setToast: (message: string) => void;
  setIndexingGuideCount: (count: number) => void;
};

export function useGuideBundle({
  preferredUrls,
  game,
  platform,
  user,
  setToast,
  setIndexingGuideCount,
}: UseGuideBundleOptions) {
  const [guideBundleMeta, setGuideBundleMeta] = useState<Record<string, GuideBundleMeta>>({});
  const [bundleIndexStatus, setBundleIndexStatus] = useState<
    Record<
      string,
      {
        pages: { slug: string; title: string; url: string; chunks: number }[];
        failedPages?: { slug: string; title: string; url: string; reason: string }[];
      }
    >
  >({});
  const [bundlePanelLoad, setBundlePanelLoad] = useState<
    Record<string, { meta: boolean; status: boolean }>
  >({});
  const [bundleStatusRev, setBundleStatusRev] = useState(0);
  const [guideIndexState, setGuideIndexState] = useState<GuideIndexState>({});
  const [guideChecking, setGuideChecking] = useState(false);
  const [guidePending, setGuidePending] = useState(false);
  const [retryingBundleUrl, setRetryingBundleUrl] = useState<string | null>(null);
  const [refreshingBundleUrl, setRefreshingBundleUrl] = useState<string | null>(null);
  const [isReindexingAll, setIsReindexingAll] = useState(false);

  const indexingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBundleIndexingPoll = useCallback(() => {
    if (indexingPollRef.current) {
      clearInterval(indexingPollRef.current);
      indexingPollRef.current = null;
    }
  }, []);

  const pollBundleIndexingProgress = useCallback(
    async (url: string, targets: string[]) => {
      try {
        const response = await fetch(`/api/guide-bundle/status?url=${encodeURIComponent(url)}`);
        if (!response.ok) return;
        const data = (await response.json()) as {
          pages?: { slug: string }[];
          failedPages?: { slug: string }[];
        };
        // Failed pages are settled (won't retry) — don't keep counting them as pending.
        const settled = new Set(
          [...(data.pages ?? []), ...(data.failedPages ?? [])].map((page) =>
            page.slug.toLowerCase(),
          ),
        );
        const remaining = targets.filter((slug) => !settled.has(slug.toLowerCase())).length;
        setIndexingGuideCount(remaining);
      } catch {
        // polling is best-effort
      }
    },
    [setIndexingGuideCount],
  );

  const startBundleIndexingPoll = useCallback(
    (url: string, targets: string[]) => {
      stopBundleIndexingPoll();
      void pollBundleIndexingProgress(url, targets);
      indexingPollRef.current = setInterval(() => {
        void pollBundleIndexingProgress(url, targets);
      }, 4000);
    },
    [pollBundleIndexingProgress, stopBundleIndexingPoll],
  );

  useEffect(() => () => stopBundleIndexingPoll(), [stopBundleIndexingPoll]);

  useEffect(() => {
    registerBundlePrefsSync(getSupabase());
  }, []);

  useEffect(() => {
    if (!user) return;
    hydrateBundlePrefsFromUser(user.user_metadata, getSupabase());
    const bundleUrls = preferredUrls.filter((url) =>
      isActiveGamefaqsBundle(url, guideBundleMeta[url]),
    );
    if (!bundleUrls.length) return;
    setGuideBundleMeta((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const url of bundleUrls) {
        const row = next[url];
        if (!row) continue;
        const prefs = getBundlePrefs(url);
        const skippedSame =
          JSON.stringify(row.skippedSlugs ?? []) === JSON.stringify(prefs.skippedSlugs);
        const selectedSame =
          JSON.stringify(row.selectedSlugs ?? null) ===
          JSON.stringify(prefs.selectedSlugs ?? null);
        if (skippedSame && selectedSame) continue;
        changed = true;
        next[url] = {
          ...row,
          skippedSlugs: prefs.skippedSlugs,
          selectedSlugs: prefs.selectedSlugs ?? row.selectedSlugs,
        };
      }
      return changed ? next : prev;
    });
    setBundleStatusRev((rev) => rev + 1);
  }, [user?.id, preferredUrls]);

  useEffect(() => {
    let cancelled = false;
    const urlsToFetch = preferredUrls.filter((url) => !isUploadedGuideUrl(url));
    if (!urlsToFetch.length) return;

    setBundlePanelLoad((prev) => {
      const next = { ...prev };
      for (const url of urlsToFetch) {
        next[url] = { meta: false, status: false };
      }
      return next;
    });

    void Promise.all(
      urlsToFetch.map(async (url) => {
        try {
          const response = await fetch(
            `/api/guide-bundle/status?url=${encodeURIComponent(url)}`,
          );
          if (!response.ok) return null;
          const data: {
            title?: string;
            pageCount?: number;
            discoveryPages?: { slug: string; title: string; url: string }[];
            pages?: { slug: string; title: string; url: string; chunks: number }[];
            failedPages?: { slug: string; title: string; url: string; reason: string }[];
          } = await response.json();
          if (
            !data.title &&
            !data.discoveryPages?.length &&
            !data.pages?.length &&
            !data.failedPages?.length
          )
            return null;
          return { url, data };
        } catch {
          return null;
        } finally {
          if (!cancelled) {
            setBundlePanelLoad((prev) => ({
              ...prev,
              [url]: { meta: true, status: true },
            }));
          }
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const found = rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
      if (!found.length) return;
      setGuideBundleMeta((prev) => {
        const next = { ...prev };
        for (const row of found) {
          const prefs = getBundlePrefs(row.url);
          const pages = filterBundlePanelPages(row.data.discoveryPages ?? [], prefs.selectedSlugs);
          next[row.url] = {
            ...prev[row.url],
            title: row.data.title ?? prev[row.url]?.title ?? "GameFAQs guide",
            pageCount:
              pages.length > 0
                ? pages.length
                : (row.data.pageCount ?? prev[row.url]?.pageCount ?? 0),
            pages: pages.length ? pages : row.data.discoveryPages,
            selectedSlugs: prev[row.url]?.selectedSlugs ?? prefs.selectedSlugs,
            skippedSlugs: prev[row.url]?.skippedSlugs ?? prefs.skippedSlugs,
            // Failed pages (blocked / not-found) drive the panel's "couldn't add" rows.
            // Duplicates are already covered by another page — settled, but not shown.
            missingPages: row.data.failedPages?.length
              ? row.data.failedPages.filter((page) => page.reason !== "duplicate")
              : prev[row.url]?.missingPages,
          };
        }
        return next;
      });
      setBundleIndexStatus((prev) => {
        const next = { ...prev };
        for (const row of found) {
          if (row.data.pages?.length || row.data.failedPages?.length) {
            next[row.url] = {
              pages: row.data.pages ?? [],
              failedPages: row.data.failedPages,
            };
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [preferredUrls, bundleStatusRev]);

  useEffect(() => {
    const urlsToSync = preferredUrls.filter((url) => !isUploadedGuideUrl(url));
    if (!urlsToSync.length) return;
    setGuideBundleMeta((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const url of urlsToSync) {
        const row = next[url];
        if (!row) continue;
        const prefs = getBundlePrefs(url);
        const skippedSame =
          JSON.stringify(row.skippedSlugs ?? []) === JSON.stringify(prefs.skippedSlugs);
        const selectedSame =
          JSON.stringify(row.selectedSlugs ?? null) ===
          JSON.stringify(prefs.selectedSlugs ?? null);
        if (skippedSame && selectedSame) continue;
        changed = true;
        next[url] = {
          ...row,
          skippedSlugs: prefs.skippedSlugs,
          selectedSlugs: prefs.selectedSlugs ?? row.selectedSlugs,
        };
      }
      return changed ? next : prev;
    });
  }, [preferredUrls]);

  useEffect(() => {
    if (!preferredUrls.length) {
      setGuideIndexState({});
      return;
    }

    let cancelled = false;

    async function fetchStatuses() {
      try {
        const response = await fetch(
          `/api/guide-ingest/status?urls=${encodeURIComponent(preferredUrls.join(","))}`,
        );
        if (!response.ok) return;
        const data: {
          available: boolean;
          results: { url: string; indexed: boolean }[];
        } = await response.json();

        if (cancelled) return;

        setGuideIndexState((prev) => {
          const next: GuideIndexState = {};
          for (const url of preferredUrls) {
            const current = prev[url];
            const item = data.results.find((r) => r.url === url);
            if (!data.available) {
              next[url] = "unavailable";
            } else if (current === "checking" || current === "failed" || current === "blocked") {
              next[url] = item?.indexed ? "indexed" : current;
            } else {
              next[url] = item?.indexed ? "indexed" : "pending";
            }
          }
          return next;
        });
      } catch (err) {
        console.error("Failed to fetch guide statuses:", err);
      }
    }

    void fetchStatuses();

    return () => {
      cancelled = true;
    };
  }, [preferredUrls, bundleStatusRev]);

  const applyIngestRowToMeta = useCallback(
    (
      url: string,
      row: Record<string, unknown>,
      existing?: GuideBundleMeta,
    ): GuideBundleMeta | undefined => {
      if (!isGamefaqsBundleUrl(url)) return existing;
      const pagesMissing = Array.isArray(row.pagesMissing)
        ? (row.pagesMissing as { slug: string; title: string; url: string; reason?: string }[]).filter(
            (page) => page.reason !== "duplicate",
          )
        : undefined;
      const prefs = mergedBundlePrefs(url, existing);
      const skipped = new Set(prefs.skippedSlugs.map((slug) => slug.toLowerCase()));
      const filteredMissing = pagesMissing?.filter(
        (page) => !skipped.has(page.slug.toLowerCase()),
      );
      return {
        title: existing?.title ?? "GameFAQs guide",
        pageCount:
          typeof row.pageCount === "number"
            ? row.pageCount
            : (existing?.pageCount ?? filteredMissing?.length ?? 0),
        pages: existing?.pages,
        selectedSlugs: existing?.selectedSlugs,
        skippedSlugs: existing?.skippedSlugs ?? prefs.skippedSlugs,
        missingPages: filteredMissing?.length ? filteredMissing : undefined,
        ...(row.isBlocked === true || existing?.isBlocked ? { isBlocked: true } : {}),
      };
    },
    [],
  );

  const retryBundleIngest = useCallback(
    async (url: string) => {
      setRetryingBundleUrl(url);
      setGuideIndexState((prev) => ({ ...prev, [url]: "checking" }));
      try {
        const response = await fetch("/api/guide-ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            preferredUrls: [url],
            game,
            platform,
            userId: user?.id ?? null,
            playerName: user ? displayNameFromMetadata(user.user_metadata) : "",
            bundlePrefs: buildBundlePrefsBody([url], guideBundleMeta),
            retryFailed: true,
          }),
        });
        if (!response.ok) {
          setGuideIndexState((prev) => ({
            ...prev,
            [url]: guideIndexStateFromIngest(undefined, guideBundleMeta[url]),
          }));
          return;
        }
        const ingestData = (await response.json()) as {
          results?: Array<Record<string, unknown>>;
        };
        const row = ingestData.results?.[0];
        if (row) {
          setGuideBundleMeta((prev) => {
            const updated = applyIngestRowToMeta(url, row, prev[url]);
            return updated ? { ...prev, [url]: updated } : prev;
          });
          setGuideIndexState((prev) => ({
            ...prev,
            [url]: guideIndexStateFromIngest(row),
          }));
          const hint = guideIngestHintFromResponse({
            available: true,
            results: [row],
          });
          if (hint) setToast(hint);
        } else {
          setGuideIndexState((prev) => ({
            ...prev,
            [url]: guideIndexStateFromIngest(undefined, guideBundleMeta[url]),
          }));
        }
        setBundleStatusRev((rev) => rev + 1);
      } catch (error) {
        console.error("Bundle retry ingest failed:", error);
        setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(undefined, guideBundleMeta[url]),
        }));
      } finally {
        setRetryingBundleUrl(null);
      }
    },
    [applyIngestRowToMeta, game, platform, user, guideBundleMeta, setToast],
  );

  const handleSkipBundlePage = useCallback((url: string, slug: string) => {
    const prefs = skipBundlePage(url, slug);
    setGuideBundleMeta((prev) => {
      const row = prev[url];
      if (!row) return prev;
      return {
        ...prev,
        [url]: {
          ...row,
          skippedSlugs: prefs.skippedSlugs,
          missingPages: row.missingPages?.filter((page) => page.slug !== slug),
        },
      };
    });
  }, []);

  const reindexAllPending = useCallback(async () => {
    if (isReindexingAll) return;
    setIsReindexingAll(true);
    try {
      const pendingUrls = preferredUrls.filter((url) => {
        const state = guideIndexState[url];
        return !state || state === "pending" || state === "failed" || state === "blocked" || state === "unknown";
      });
      for (const url of pendingUrls) {
        await retryBundleIngest(url);
      }
    } finally {
      setIsReindexingAll(false);
    }
  }, [preferredUrls, guideIndexState, retryBundleIngest, isReindexingAll]);

  const handleUnskipBundlePage = useCallback((url: string, slug: string) => {
    const prefs = unskipBundlePage(url, slug);
    setGuideBundleMeta((prev) => {
      const row = prev[url];
      if (!row) return prev;
      return { ...prev, [url]: { ...row, skippedSlugs: prefs.skippedSlugs } };
    });
  }, []);

  const handleSkipAllMissingBundlePages = useCallback((url: string, missingSlugs: string[]) => {
    if (!missingSlugs.length) return;
    const prefs = skipAllMissingBundlePages(url, missingSlugs);
    setGuideBundleMeta((prev) => {
      const row = prev[url];
      if (!row) return prev;
      const skipped = new Set(prefs.skippedSlugs.map((slug) => slug.toLowerCase()));
      return {
        ...prev,
        [url]: {
          ...row,
          skippedSlugs: prefs.skippedSlugs,
          missingPages: row.missingPages?.filter(
            (page) => !skipped.has(page.slug.toLowerCase()),
          ),
        },
      };
    });
  }, []);

  const refreshBundleDiscovery = useCallback(async (url: string) => {
    setRefreshingBundleUrl(url);
    try {
      const response = await fetch(
        `/api/guide-bundle?url=${encodeURIComponent(url)}&refresh=1`,
      );
      const data: {
        bundle?: boolean;
        pageCount?: number;
        title?: string;
        pages?: { slug: string; title: string; url: string }[];
      } = await response.json();
      if (!response.ok || !data.bundle || typeof data.pageCount !== "number") return;
      const rawPageCount = data.pageCount;
      setGuideBundleMeta((prev) => {
        const existing = prev[url];
        const prefs = mergedBundlePrefs(url, existing);
        const pages = filterBundlePanelPages(data.pages ?? [], prefs.selectedSlugs);
        const pageCount = pages.length > 0 ? pages.length : rawPageCount;
        return {
          ...prev,
          [url]: {
            title: data.title ?? existing?.title ?? "GameFAQs guide",
            pageCount,
            pages: pages as { slug: string; title: string; url: string }[],
            selectedSlugs: existing?.selectedSlugs ?? prefs.selectedSlugs,
            skippedSlugs: existing?.skippedSlugs ?? prefs.skippedSlugs,
            missingPages: existing?.missingPages,
          },
        };
      });
      setBundleStatusRev((rev) => rev + 1);
    } catch (error) {
      console.error("Bundle discovery refresh failed:", error);
    } finally {
      setRefreshingBundleUrl(null);
    }
  }, []);

  const resetGuideBundle = useCallback(() => setGuideBundleMeta({}), []);

  const bundlePageTotal = preferredUrls.reduce(
    (sum, url) => sum + (guideBundleMeta[url]?.pageCount ?? 0),
    0,
  );

  return {
    guideBundleMeta,
    setGuideBundleMeta,
    bundleIndexStatus,
    bundlePanelLoad,
    guideIndexState,
    setGuideIndexState,
    setBundleStatusRev,
    guideChecking,
    setGuideChecking,
    guidePending,
    setGuidePending,
    retryingBundleUrl,
    refreshingBundleUrl,
    isReindexingAll,
    bundlePageTotal,
    applyIngestRowToMeta,
    retryBundleIngest,
    handleSkipBundlePage,
    handleUnskipBundlePage,
    handleSkipAllMissingBundlePages,
    refreshBundleDiscovery,
    reindexAllPending,
    resetGuideBundle,
    startBundleIndexingPoll,
    stopBundleIndexingPoll,
  };
}
