"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import {
  type GuideIndexState,
  guideIndexStateFromIngest,
} from "@/lib/guide-index-state";
import { isUploadedGuideUrl } from "@/lib/guide-urls.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import type { GuideMeta } from "../guide-link-field";

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
  const [guideMeta, setGuideMeta] = useState<Record<string, GuideMeta>>({});
  const [guideIndexState, setGuideIndexState] = useState<GuideIndexState>({});
  const [guideChecking, setGuideChecking] = useState(false);
  const [guidePending, setGuidePending] = useState(false);
  const [retryingUrl, setRetryingUrl] = useState<string | null>(null);
  const [isReindexingAll, setIsReindexingAll] = useState(false);
  const [statusRev, setStatusRev] = useState(0);

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
          results: { url: string; indexed: boolean; title?: string }[];
        } = await response.json();

        if (cancelled) return;

        setGuideMeta((prev) => {
          let next = prev;
          for (const item of data.results) {
            if (!item.title) continue;
            const existing = prev[item.url];
            if (existing?.title === item.title) continue;
            next = { ...next, [item.url]: { ...existing, title: item.title } };
          }
          return next === prev ? prev : next;
        });

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
  }, [preferredUrls, statusRev]);

  const applyIngestRowToMeta = useCallback(
    (url: string, row: Record<string, unknown>, existing?: GuideMeta): GuideMeta | undefined => {
      if (!row || typeof row !== "object") return existing;
      const title =
        typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : existing?.title;
      return {
        ...(title ? { title } : {}),
        ...(row.isBlocked === true || existing?.isBlocked ? { isBlocked: true } : {}),
      };
    },
    [],
  );

  const retryGuideIngest = useCallback(
    async (url: string) => {
      setRetryingUrl(url);
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
          }),
        });
        if (!response.ok) {
          setGuideIndexState((prev) => ({
            ...prev,
            [url]: guideIndexStateFromIngest(undefined, guideMeta[url]),
          }));
          return;
        }
        const ingestData = (await response.json()) as {
          results?: Array<Record<string, unknown>>;
        };
        const row = ingestData.results?.[0];
        if (row) {
          setGuideMeta((prev) => {
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
            [url]: guideIndexStateFromIngest(undefined, guideMeta[url]),
          }));
        }
        setStatusRev((rev) => rev + 1);
      } catch (error) {
        console.error("Guide retry ingest failed:", error);
        setGuideIndexState((prev) => ({
          ...prev,
          [url]: guideIndexStateFromIngest(undefined, guideMeta[url]),
        }));
      } finally {
        setRetryingUrl(null);
      }
    },
    [applyIngestRowToMeta, game, platform, user, guideMeta, setToast],
  );

  const reindexAllPending = useCallback(async () => {
    if (isReindexingAll) return;
    setIsReindexingAll(true);
    try {
      const pendingUrls = preferredUrls.filter((url) => {
        const state = guideIndexState[url];
        return !state || state === "pending" || state === "failed" || state === "blocked" || state === "unknown";
      });
      for (const url of pendingUrls) {
        await retryGuideIngest(url);
      }
    } finally {
      setIsReindexingAll(false);
    }
  }, [preferredUrls, guideIndexState, retryGuideIngest, isReindexingAll]);

  const resetGuideMeta = useCallback(() => setGuideMeta({}), []);

  return {
    guideMeta,
    setGuideMeta,
    guideIndexState,
    setGuideIndexState,
    setStatusRev,
    guideChecking,
    setGuideChecking,
    guidePending,
    setGuidePending,
    retryingUrl,
    isReindexingAll,
    applyIngestRowToMeta,
    retryGuideIngest,
    reindexAllPending,
    resetGuideMeta,
  };
}
