import { targetBundleSlugs } from "@/lib/bundle-prefs.js";
import {
  buildBundlePrefsBody,
  guideUrlNeedsIngest,
  mergedBundlePrefs,
  settledBundleSlugs,
} from "@/lib/guide-card-ui.js";
import { guideIngestHint, guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import { guideIndexStateFromIngest } from "@/lib/guide-index-state";
import { isActiveGamefaqsBundle, normalizeGuideUrlList } from "@/lib/guide-urls.js";
import type { GuideBundleMeta } from "../guide-link-field";
import type { ChatTurnDeps } from "./chat-turn-deps";
import { displayNameFromMetadata } from "@/lib/profile.js";

export type GuideIngestTurnParams = {
  deps: ChatTurnDeps;
  guideUrls: string[];
  traceId: string;
  signal: AbortSignal;
};

export type GuideIngestTurnResult = {
  hint: string;
  hasIndexedGuides: boolean;
} | null;

export async function runGuideIngestForTurn({
  deps,
  guideUrls,
  traceId,
  signal,
}: GuideIngestTurnParams): Promise<GuideIngestTurnResult> {
  const urlsNeedingIngest = guideUrls.filter((url) =>
    guideUrlNeedsIngest(
      url,
      deps.guideBundleMeta[url],
      deps.bundleIndexStatus[url],
      deps.guideIndexState[url],
    ),
  );
  if (!urlsNeedingIngest.length) return null;

  let ingestBundleUrl: string | undefined;
  let bundleTargets: string[] = [];

  ingestBundleUrl = urlsNeedingIngest.find((url) =>
    isActiveGamefaqsBundle(url, deps.guideBundleMeta[url]),
  );
  if (ingestBundleUrl) {
    const meta = deps.guideBundleMeta[ingestBundleUrl];
    const prefs = mergedBundlePrefs(ingestBundleUrl, meta);
    const discovered = meta?.pages ?? [];
    bundleTargets = discovered.length ? targetBundleSlugs(discovered, prefs) : [];
    const indexedSlugs = settledBundleSlugs(deps.bundleIndexStatus[ingestBundleUrl]);
    const indexedSet = new Set(indexedSlugs.map((slug) => slug.toLowerCase()));
    const pending = bundleTargets.length
      ? bundleTargets.filter((slug) => !indexedSet.has(slug)).length
      : Math.max(meta?.pageCount ?? 0, 1);
    deps.setIndexingIsBundlePages(true);
    deps.setIndexingGuideCount(Math.max(pending, 1));
    if (bundleTargets.length && pending > 0) {
      deps.startBundleIndexingPoll(ingestBundleUrl, bundleTargets);
    }
  } else {
    deps.setIndexingIsBundlePages(false);
    deps.setIndexingGuideCount(urlsNeedingIngest.length > 1 ? urlsNeedingIngest.length : 1);
  }

  deps.setGuideIndexState((prev) => {
    const next = { ...prev };
    for (const url of urlsNeedingIngest) {
      next[url] = "checking";
    }
    return next;
  });

  const ingestResults: Array<Record<string, unknown>> = [];
  let hubWarning = false;
  let bundleMetaForRun = { ...deps.guideBundleMeta };

  try {
    for (const url of urlsNeedingIngest) {
      const ingestResponse = await fetch("/api/guide-ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Trace-Id": traceId,
        },
        signal,
        body: JSON.stringify({
          preferredUrls: [url],
          game: deps.game,
          platform: deps.platform,
          userId: deps.user?.id ?? null,
          playerName: deps.user ? displayNameFromMetadata(deps.user.user_metadata) : "",
          bundlePrefs: buildBundlePrefsBody(guideUrls, deps.guideBundleMeta),
        }),
      });
      if (ingestResponse.ok) {
        const ingestData = (await ingestResponse.json()) as {
          indexed?: boolean;
          hubWarning?: boolean;
          results?: Array<Record<string, unknown>>;
        };
        const row =
          ingestData.results?.[0] ??
          ({ indexed: ingestData.indexed, hubWarning: ingestData.hubWarning } as const);
        ingestResults.push(row);
        if (ingestData.hubWarning) hubWarning = true;
        const updated = deps.applyIngestRowToMeta(url, row, bundleMetaForRun[url]);
        if (updated) {
          bundleMetaForRun = { ...bundleMetaForRun, [url]: updated };
        }
        deps.setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(row, updated ?? bundleMetaForRun[url]),
        }));
      } else if (!signal.aborted) {
        ingestResults.push({ indexed: false });
        deps.setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(undefined, deps.guideBundleMeta[url]),
        }));
      }
    }

    if (ingestResults.length) {
      const previouslyIndexedCount = guideUrls.filter(
        (url) => !urlsNeedingIngest.includes(url),
      ).length;
      const newlyIndexedCount = ingestResults.filter((row) => row.indexed).length;
      const totalIndexedCount = previouslyIndexedCount + newlyIndexedCount;
      const hint = guideIngestHintFromResponse({
        available: true,
        indexedCount: totalIndexedCount,
        total: guideUrls.length,
        hubWarning,
        results: ingestResults,
      });
      if (Object.keys(bundleMetaForRun).length) {
        deps.setGuideBundleMeta(bundleMetaForRun);
      }
      deps.setBundleStatusRev((rev) => rev + 1);
      return hint ? { hint, hasIndexedGuides: totalIndexedCount > 0 } : null;
    }
  } catch (ingestError) {
    if (!(ingestError instanceof DOMException && ingestError.name === "AbortError")) {
      console.error("Guide ingest failed:", ingestError);
      deps.setGuideIndexState((prev) => {
        const next = { ...prev };
        for (const url of urlsNeedingIngest) {
          if (next[url] === "checking") {
            next[url] = guideIndexStateFromIngest(undefined, deps.guideBundleMeta[url]);
          }
        }
        return next;
      });
      const previouslyIndexedCount = guideUrls.filter(
        (url) => !urlsNeedingIngest.includes(url),
      ).length;
      const hint = guideIngestHint({
        available: true,
        indexed: false,
        total: guideUrls.length,
        indexedCount: previouslyIndexedCount,
      });
      return hint ? { hint, hasIndexedGuides: previouslyIndexedCount > 0 } : null;
    }
  } finally {
    deps.stopBundleIndexingPoll();
    if (ingestBundleUrl && bundleTargets.length) {
      try {
        const finalRes = await fetch(
          `/api/guide-bundle/status?url=${encodeURIComponent(ingestBundleUrl)}`,
        );
        if (finalRes.ok) {
          const finalData = (await finalRes.json()) as { pages?: { slug: string }[] };
          const indexed = new Set(
            (finalData.pages ?? []).map((page) => page.slug.toLowerCase()),
          );
          const remaining = bundleTargets.filter(
            (slug) => !indexed.has(slug.toLowerCase()),
          ).length;
          deps.setIndexingGuideCount(remaining);
        } else {
          deps.setIndexingGuideCount(0);
        }
      } catch {
        deps.setIndexingGuideCount(0);
      }
    } else {
      deps.setIndexingGuideCount(0);
    }
    deps.setIndexingIsBundlePages(false);
  }

  return null;
}

export function urlsNeedingIngestForTurn(deps: ChatTurnDeps, guideUrls: string[]) {
  return guideUrls.filter((url) =>
    guideUrlNeedsIngest(
      url,
      deps.guideBundleMeta[url],
      deps.bundleIndexStatus[url],
      deps.guideIndexState[url],
    ),
  );
}

export function normalizedGuideUrls(preferredUrls: string[]) {
  return normalizeGuideUrlList(preferredUrls);
}
