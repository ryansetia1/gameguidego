"use client";

import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import {
  type GuideIndexState,
  guideIndexStateFromIngest,
  guideIndexStateFromStatus,
} from "@/lib/guide-index-state";
import { isSamePreferredGuide } from "@/lib/guide-urls.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import { getSupabase } from "@/lib/supabase";
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
  const retryingUrlRef = useRef<string | null>(null);
  retryingUrlRef.current = retryingUrl;
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
          results: { url: string; indexed: boolean; status?: string; title?: string }[];
        } = await response.json();

        if (cancelled) return;

        setGuideMeta((prev) => {
          let next = prev;
          for (const item of data.results) {
            if (!item.title) continue;
            const key = preferredUrls.find((url) => isSamePreferredGuide(url, item.url));
            if (!key) continue;
            const existing = prev[key];
            if (existing?.title === item.title) continue;
            next = { ...next, [key]: { ...existing, title: item.title } };
          }
          return next === prev ? prev : next;
        });

        setGuideIndexState((prev) => {
          const next: GuideIndexState = {};
          for (const url of preferredUrls) {
            const current = prev[url];
            const item = data.results.find((r) => isSamePreferredGuide(r.url, url));
            const serverState = !data.available
              ? "unavailable"
              : guideIndexStateFromStatus(item);
            if (!data.available) {
              next[url] = "unavailable";
            } else if (current === "checking" || current === "failed" || current === "blocked") {
              next[url] = item?.indexed ? serverState : current;
            } else if (retryingUrlRef.current === url && serverState === "limited") {
              next[url] = "refreshing";
            } else {
              next[url] = serverState;
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

  const hasRefreshing = preferredUrls.some((url) => guideIndexState[url] === "refreshing");
  useEffect(() => {
    if (!hasRefreshing) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > 20) {
        clearInterval(timer);
        return;
      }
      setStatusRev((rev) => rev + 1);
    }, 6000);
    return () => clearInterval(timer);
  }, [hasRefreshing]);

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
      const isLimitedRefresh = guideIndexState[url] === "limited";
      retryingUrlRef.current = url;
      setRetryingUrl(url);
      setGuideIndexState((prev) => ({
        ...prev,
        [url]: isLimitedRefresh ? "refreshing" : "checking",
      }));
      try {
        const sessionRes = isLimitedRefresh ? await getSupabase()?.auth.getSession() : null;
        const accessToken = sessionRes?.data?.session?.access_token;
        const response = await fetch("/api/guide-ingest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            preferredUrls: [url],
            ...(isLimitedRefresh ? { refreshEmbeddings: true } : {}),
            game,
            platform,
            userId: user?.id ?? null,
            playerName: user ? displayNameFromMetadata(user.user_metadata) : "",
          }),
        });
        if (!response.ok) {
          if (isLimitedRefresh) {
            setGuideIndexState((prev) => ({ ...prev, [url]: "limited" }));
            setToast("Couldn't refresh right now. Try again in a moment.");
          } else {
            setGuideIndexState((prev) => ({
              ...prev,
              [url]: guideIndexStateFromIngest(undefined, guideMeta[url]),
            }));
            setToast("Indexing paused, try again later.");
          }
          return;
        }
        const ingestData = (await response.json()) as {
          results?: Array<Record<string, unknown>>;
        };
        const row = ingestData.results?.[0];
        if (isLimitedRefresh) {
          if (row?.refreshed) {
            setGuideIndexState((prev) => ({ ...prev, [url]: "indexed" }));
            setToast("Guide refreshed — full search restored.");
          } else {
            setGuideIndexState((prev) => ({
              ...prev,
              [url]: guideIndexStateFromIngest(row, guideMeta[url]),
            }));
            setToast("Couldn't refresh right now. Try again in a moment.");
          }
          setStatusRev((rev) => rev + 1);
          return;
        }
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
          [url]: isLimitedRefresh
            ? "limited"
            : guideIndexStateFromIngest(undefined, guideMeta[url]),
        }));
        if (isLimitedRefresh) {
          setToast("Couldn't refresh right now. Try again in a moment.");
        }
      } finally {
        retryingUrlRef.current = null;
        setRetryingUrl(null);
      }
    },
    [applyIngestRowToMeta, game, platform, user, guideMeta, guideIndexState, setToast],
  );

  const reindexAllPending = useCallback(async () => {
    if (isReindexingAll) return;
    setIsReindexingAll(true);
    try {
      const pendingUrls = preferredUrls.filter((url) => {
        const state = guideIndexState[url];
        return (
          !state ||
          state === "pending" ||
          state === "limited" ||
          state === "failed" ||
          state === "blocked" ||
          state === "unknown"
        );
      });
      for (const url of pendingUrls) {
        await retryGuideIngest(url);
      }
    } finally {
      setIsReindexingAll(false);
    }
  }, [preferredUrls, guideIndexState, retryGuideIngest, isReindexingAll]);

  // Auto-index a freshly added guide in the background. This lives at page scope
  // (the hook never unmounts on topic/room navigation) and retryGuideIngest fires
  // NO abort signal, so navigating away never cancels an in-flight ingest — the
  // user can chat in another room and come back when it finishes. The ref guards
  // against re-firing the same URL (across re-renders and room switches) while its
  // ingest is still running.
  const autoIngestingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const url of preferredUrls) {
      if (guideIndexState[url] === "pending" && !autoIngestingRef.current.has(url)) {
        autoIngestingRef.current.add(url);
        void retryGuideIngest(url).finally(() => autoIngestingRef.current.delete(url));
      }
    }
  }, [preferredUrls, guideIndexState, retryGuideIngest]);

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
