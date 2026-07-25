import { guideUrlNeedsIngest } from "@/lib/guide-card-ui.js";
import { guideIngestHint, guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import { guideIndexStateFromIngest } from "@/lib/guide-index-state";
import { normalizeGuideUrlList } from "@/lib/guide-urls.js";
import type { GuideMeta } from "../guide-link-field";
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
    guideUrlNeedsIngest(url, deps.guideIndexState[url]),
  );
  if (!urlsNeedingIngest.length) return null;

  deps.setIndexingGuideCount(urlsNeedingIngest.length);

  deps.setGuideIndexState((prev) => {
    const next = { ...prev };
    for (const url of urlsNeedingIngest) {
      next[url] = "checking";
    }
    return next;
  });

  const ingestResults: Array<Record<string, unknown>> = [];
  let hubWarning = false;
  let guideMetaForRun = { ...deps.guideMeta };

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
        const updated = deps.applyIngestRowToMeta(url, row, guideMetaForRun[url]);
        if (updated) {
          guideMetaForRun = { ...guideMetaForRun, [url]: updated };
        }
        deps.setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(row, updated ?? guideMetaForRun[url]),
        }));
      } else if (!signal.aborted) {
        ingestResults.push({ indexed: false });
        deps.setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(undefined, deps.guideMeta[url]),
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
      if (Object.keys(guideMetaForRun).length) {
        deps.setGuideMeta(guideMetaForRun);
      }
      deps.setStatusRev((rev) => rev + 1);
      return hint ? { hint, hasIndexedGuides: totalIndexedCount > 0 } : null;
    }
  } catch (ingestError) {
    if (!(ingestError instanceof DOMException && ingestError.name === "AbortError")) {
      console.error("Guide ingest failed:", ingestError);
      deps.setGuideIndexState((prev) => {
        const next = { ...prev };
        for (const url of urlsNeedingIngest) {
          if (next[url] === "checking") {
            next[url] = guideIndexStateFromIngest(undefined, deps.guideMeta[url]);
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
    deps.setIndexingGuideCount(0);
  }

  return null;
}

export function urlsNeedingIngestForTurn(deps: ChatTurnDeps, guideUrls: string[]) {
  return guideUrls.filter((url) =>
    guideUrlNeedsIngest(url, deps.guideIndexState[url]),
  );
}

export function normalizedGuideUrls(preferredUrls: string[]) {
  return normalizeGuideUrlList(preferredUrls);
}
