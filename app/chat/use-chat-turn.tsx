"use client";

import type { User } from "@supabase/supabase-js";
import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import { useRef } from "react";
import {
  buildAssistantVariantBody,
  buildTurnMessagesWithAssistant,
  pollUntilMessagesRecovered,
  serverOwnsAssistantPersist,
  shouldApplySyncedMessages,
} from "@/lib/chat-persist.js";
import {
  loadThreadMessages,
  syncThreadFromMessages,
} from "@/lib/chat-thread-persist.js";
import { priorMessagesForRegen } from "@/lib/chat-thread.js";
import {
  WRITING_ANSWER_PLACEHOLDER,
  pollRecoveredMessages,
  snapshotAssistantVariants,
} from "@/lib/chat-messages.js";
import { uploadedSourceGuideLabel } from "@/lib/chat-message-ui.js";
import { guideIngestHint, guideIngestHintFromResponse } from "@/lib/guide-hints.js";
import {
  bundleHasPendingPages,
  getBundlePrefs,
  targetBundleSlugs,
} from "@/lib/bundle-prefs.js";
import {
  guideUrlsPayload,
  isActiveGamefaqsBundle,
  isGamefaqsBundleUrl,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import { coerceHighlights, coerceSpoilers } from "@/lib/highlights.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import { getSupabase } from "@/lib/supabase";
import { loadLocalGames, upsertLocalGame } from "@/lib/local-games.js";
import type { GuideBundleMeta } from "../guide-link-field";
import type { Message, Source } from "./types";
import type { SpoilerPrefs } from "@/lib/spoiler-prefs.js";

function buildBundlePrefsBody(
  urls: string[],
  meta?: Record<string, GuideBundleMeta>,
) {
  const out: Record<string, { skipSlugs: string[]; includeSlugs?: string[] }> = {};
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

function mergedBundlePrefs(url: string, meta?: GuideBundleMeta) {
  const stored = getBundlePrefs(url);
  return {
    skippedSlugs: meta?.skippedSlugs ?? stored.skippedSlugs ?? [],
    selectedSlugs: meta?.selectedSlugs ?? stored.selectedSlugs,
  };
}

function guideUrlNeedsIngest(
  url: string,
  meta: GuideBundleMeta | undefined,
  indexStatus: { pages: { slug: string }[] } | undefined,
  indexState: string | undefined,
) {
  if (indexState === "indexed") return false;
  const bundlePages = meta?.pageCount && meta.pageCount > 1;
  const discovered = meta?.pages ?? [];
  const indexedSlugs = indexStatus?.pages?.map((page) => page.slug) ?? [];
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

export type ChatTurnDeps = {
  temporary: boolean;
  user: User | null;
  game: string;
  platform: string;
  preferredUrls: string[];
  cover: string;
  releaseYear: string;
  messages: Message[];
  input: string;
  editingIndex: number | null;
  loading: boolean;
  guideBundleMeta: Record<string, GuideBundleMeta>;
  bundleIndexStatus: Record<string, { pages: { slug: string }[] }>;
  guideIndexState: Record<string, string>;
  spoilerPrefs: SpoilerPrefs;
  setActiveChatId: (id: string | null) => void;
  setChats: (chats: import("@/lib/supabase").Chat[]) => void;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setError: (value: string) => void;
  setRetryAction: (value: (() => void) | null) => void;
  setLoading: (value: boolean) => void;
  setGenerationStatus: (value: string | null) => void;
  setEditingIndex: (value: number | null) => void;
  setIndexingIsBundlePages: (value: boolean) => void;
  setIndexingGuideCount: (value: number) => void;
  setGuideIndexState: React.Dispatch<
    React.SetStateAction<
      Record<string, "unknown" | "checking" | "indexed" | "failed" | "unavailable" | "pending">
    >
  >;
  setGuideBundleMeta: Dispatch<SetStateAction<Record<string, GuideBundleMeta>>>;
  setBundleStatusRev: Dispatch<SetStateAction<number>>;
  setConfirmFallbackModal: (value: {
    hint: string;
    hasIndexedGuides: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } | null) => void;
  setEditingGame: (value: boolean) => void;
  setNewGameOpen: (value: boolean) => void;
  setOptPanel: (value: "guide" | "spoiler" | null) => void;
  setToast: (value: string) => void;
  setInput: (value: string | ((prev: string) => string)) => void;
  setPendingImages: React.Dispatch<
    React.SetStateAction<{ blob?: Blob; preview: string; isExisting?: boolean }[]>
  >;
  activeChatIdRef: RefObject<string | null>;
  backgroundMessagesRef: RefObject<Record<string, Message[]>>;
  backgroundLoadingRef: RefObject<Record<string, boolean>>;
  backgroundStatusRef: RefObject<Record<string, string | null>>;
  abortRefs: RefObject<Record<string, AbortController>>;
  predictionIdsRef: RefObject<Record<string, string>>;
  conversationGame: RefObject<string>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  loadChats: () => Promise<void>;
  resolveCoverUrl: () => Promise<string>;
  uploadMessageImages: () => Promise<string[]>;
  clearPendingImages: () => void;
  deleteMessageImages: (messages: Message[]) => Promise<void>;
  askConfirm: (message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  applyIngestRowToMeta: (
    url: string,
    row: Record<string, unknown>,
    existing?: GuideBundleMeta,
  ) => GuideBundleMeta | undefined;
  startBundleIndexingPoll: (url: string, targets: string[]) => void;
  stopBundleIndexingPoll: () => void;
  normGame: (value: string) => string;
};

export function useChatTurn(deps: ChatTurnDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

    async function persistChat(nextMessages: Message[], targetChatId: string | null) {
    const d = depsRef.current;
      if (d.temporary) return null; // d.temporary chat: nothing gets written anywhere
      const supabase = getSupabase();
      // Anon: persist to localStorage (Chat-shaped, no Storage — d.cover is CDN/"").
      if (!supabase || !d.user) {
        const id = targetChatId ?? crypto.randomUUID();
        upsertLocalGame({
          id,
          game: d.game,
          platform: d.platform,
          ...guideUrlsPayload(d.preferredUrls),
          cover_url: d.cover.startsWith("blob:") ? "" : d.cover,
          release_year: d.releaseYear,
          messages: nextMessages,
          updated_at: new Date().toISOString(),
        });
        if (!targetChatId) d.setActiveChatId(id);
        d.setChats(loadLocalGames());
        return id;
      }
      // Upload a pending device d.cover only now (message is being saved), so covers
      // never land in Storage for abandoned drafts.
      const coverUrl = await d.resolveCoverUrl();
      const payload = {
        game: d.game,
        platform: d.platform,
        ...guideUrlsPayload(d.preferredUrls),
        cover_url: coverUrl,
        release_year: d.releaseYear,
        messages: nextMessages,
        updated_at: new Date().toISOString(),
      };
      try {
        if (targetChatId) {
          await supabase.from("chats").update(payload).eq("id", targetChatId);
          void syncThreadFromMessages(supabase, targetChatId, nextMessages).catch(() => {});
          void d.loadChats();
          return targetChatId;
        }
        const { data } = await supabase
          .from("chats")
          .insert({ ...payload, user_id: d.user.id })
          .select("id")
          .single();
        const newId = data ? (data as { id: string }).id : null;
        if (newId) {
          d.setActiveChatId(newId);
          void syncThreadFromMessages(supabase, newId, nextMessages).catch(() => {});
          void d.loadChats();
        }
        return newId;
      } catch (caught) {
        console.error("Failed to save chat:", caught);
        return targetChatId;
      }
    }

    async function runTurn(
      question: string,
      priorMessages: Message[],
      targetChatId: string | null,
      images: string[] = [],
      retryContext: any = null,
      oldAssistantMessage?: Message,
    ) {
    const d = depsRef.current;
      const traceId = crypto.randomUUID();
      d.setError("");
      d.setRetryAction(null);
      if (!navigator.onLine) {
        d.setError("You are offline. Please check your internet connection.");
        return;
      }
      d.setLoading(true);
      d.setGenerationStatus(null);
      d.setEditingIndex(null);
      let succeeded = false;
      const guideUrls = normalizeGuideUrlList(d.preferredUrls);

      const history = priorMessages
        .slice(-10)
        .map(({ role, content }) => ({ role, content }));
      const userMessage: Message = {
        role: "user",
        content: question,
        ...(images.length ? { images } : {}),
      };
      const optimistic: Message[] = oldAssistantMessage
        ? [
            ...(priorMessagesForRegen(priorMessages, userMessage) as Message[]),
            {
              ...oldAssistantMessage,
              content: WRITING_ANSWER_PLACEHOLDER,
              variants: snapshotAssistantVariants(oldAssistantMessage) as NonNullable<Message["variants"]>,
            },
          ]
        : [...priorMessages, userMessage];
      d.setMessages(optimistic);
      let activeId = targetChatId;
      if (!d.temporary) {
        activeId = await persistChat(optimistic, targetChatId) || activeId;
      }
      if (activeId) d.activeChatIdRef.current = activeId;

      if (activeId) {
        d.backgroundMessagesRef.current[activeId] = optimistic;
        d.backgroundLoadingRef.current[activeId] = true;
        d.backgroundStatusRef.current[activeId] = null;
      }

      const controller = new AbortController();
      if (activeId) d.abortRefs.current[activeId] = controller;

      const urlsNeedingIngest = guideUrls.filter((url) =>
        guideUrlNeedsIngest(url, d.guideBundleMeta[url], d.bundleIndexStatus[url], d.guideIndexState[url]),
      );
      // T2-3: hoist so the finally block can do a final status check.
      let ingestBundleUrl: string | undefined;
      let bundleTargets: string[] = [];
      if (urlsNeedingIngest.length) {
        ingestBundleUrl = urlsNeedingIngest.find((url) =>
          isActiveGamefaqsBundle(url, d.guideBundleMeta[url]),
        );
        if (ingestBundleUrl) {
          const meta = d.guideBundleMeta[ingestBundleUrl];
          const prefs = mergedBundlePrefs(ingestBundleUrl, meta);
          const discovered = meta?.pages ?? [];
          bundleTargets = discovered.length ? targetBundleSlugs(discovered, prefs) : [];
          const indexedSlugs =
            d.bundleIndexStatus[ingestBundleUrl]?.pages?.map((page) => page.slug) ?? [];
          const indexedSet = new Set(indexedSlugs.map((slug) => slug.toLowerCase()));
          const pending = bundleTargets.length
            ? bundleTargets.filter((slug) => !indexedSet.has(slug)).length
            : Math.max(meta?.pageCount ?? 0, 1);
          d.setIndexingIsBundlePages(true);
          d.setIndexingGuideCount(Math.max(pending, 1));
          if (bundleTargets.length && pending > 0) d.startBundleIndexingPoll(ingestBundleUrl, bundleTargets);
        } else {
          d.setIndexingIsBundlePages(false);
          d.setIndexingGuideCount(
            urlsNeedingIngest.length > 1 ? urlsNeedingIngest.length : 1,
          );
        }
      }

      const runGuideIngest = async (): Promise<{ hint: string; hasIndexedGuides: boolean } | null> => {
        if (!urlsNeedingIngest.length) return null;
        d.setGuideIndexState((prev) => {
          const next = { ...prev };
          for (const url of urlsNeedingIngest) {
            next[url] = "checking";
          }
          return next;
        });
        const ingestResults: Array<Record<string, unknown>> = [];
        let hubWarning = false;
        let bundleMetaForRun = { ...d.guideBundleMeta };
        try {
          for (const url of urlsNeedingIngest) {
            const ingestResponse = await fetch("/api/guide-ingest", {
              method: "POST",
              headers: { 
                "Content-Type": "application/json",
                "X-Trace-Id": traceId
              },
              signal: controller.signal,
              body: JSON.stringify({
                preferredUrls: [url],
                game: d.game,
                platform: d.platform,
                userId: d.user?.id ?? null,
                bundlePrefs: buildBundlePrefsBody(guideUrls, d.guideBundleMeta),
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
              const updated = d.applyIngestRowToMeta(url, row, bundleMetaForRun[url]);
              if (updated) {
                bundleMetaForRun = { ...bundleMetaForRun, [url]: updated };
              }
              d.setGuideIndexState((prev) => ({
                ...prev,
                [url]: row.indexed ? "indexed" : "failed",
              }));
            } else if (!controller.signal.aborted) {
              ingestResults.push({ indexed: false });
              d.setGuideIndexState((prev) => ({
                ...prev,
                [url]: "failed",
              }));
            }
          }
          if (ingestResults.length) {
            const previouslyIndexedCount = guideUrls.filter((url) => !urlsNeedingIngest.includes(url)).length;
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
              d.setGuideBundleMeta(bundleMetaForRun);
            }
            d.setBundleStatusRev((rev) => rev + 1);
            return hint ? { hint, hasIndexedGuides: totalIndexedCount > 0 } : null;
          }
        } catch (ingestError) {
          if (!(ingestError instanceof DOMException && ingestError.name === "AbortError")) {
            console.error("Guide ingest failed:", ingestError);
            d.setGuideIndexState((prev) => {
              const next = { ...prev };
              for (const url of urlsNeedingIngest) {
                if (next[url] === "checking") {
                  next[url] = "failed";
                }
              }
              return next;
            });
            const previouslyIndexedCount = guideUrls.filter((url) => !urlsNeedingIngest.includes(url)).length;
            const hint = guideIngestHint({
              available: true,
              indexed: false,
              total: guideUrls.length,
              indexedCount: previouslyIndexedCount,
            });
            return hint ? { hint, hasIndexedGuides: previouslyIndexedCount > 0 } : null;
          }
        } finally {
          d.stopBundleIndexingPoll();
          // T2-3: Honest polling finish — do a final status read to verify
          // actual indexed state instead of blindly showing "complete".
          if (ingestBundleUrl && bundleTargets.length) {
            try {
              const finalRes = await fetch(
                `/api/guide-bundle/status?url=${encodeURIComponent(ingestBundleUrl)}`,
              );
              if (finalRes.ok) {
                const finalData = (await finalRes.json()) as {
                  pages?: { slug: string }[];
                };
                const indexed = new Set(
                  (finalData.pages ?? []).map((p: { slug: string }) => p.slug.toLowerCase()),
                );
                const remaining = bundleTargets.filter(
                  (slug) => !indexed.has(slug.toLowerCase()),
                ).length;
                d.setIndexingGuideCount(remaining);
              } else {
                d.setIndexingGuideCount(0);
              }
            } catch {
              d.setIndexingGuideCount(0);
            }
          } else {
            d.setIndexingGuideCount(0);
          }
          d.setIndexingIsBundlePages(false);
        }
        return null;
      };

      const ingestPromise = urlsNeedingIngest.length ? runGuideIngest() : null;
      let streamStarted = false;
      let currentContext: any = null;

      try {
        // Finish indexing BEFORE asking solve. solve runs its own safety
        // ensureGuideIngested, so firing both concurrently double-ingests a fresh
        // guide (2x Tavily extract + 2x embed, racing each other). Awaiting first
        // makes solve's ingest a no-op skip while keeping the answer grounded in
        // the guide (and the indexing progress UI runs during this await).
        const supabase = getSupabase();
        let accessToken = "";
        if (supabase) {
          const { data: sessionData } = await supabase.auth.getSession();
          accessToken = sessionData.session?.access_token || "";
        }

        let ingestResult = ingestPromise ? await ingestPromise : null;
        let userConfirmedFallback = true;
        if (ingestResult?.hint && ingestResult.hint.includes("Couldn't read")) {
          userConfirmedFallback = await new Promise<boolean>((resolve) => {
            d.setConfirmFallbackModal({
              hint: ingestResult!.hint,
              hasIndexedGuides: ingestResult!.hasIndexedGuides,
              onConfirm: () => {
                d.setConfirmFallbackModal(null);
                resolve(true);
              },
              onCancel: () => {
                d.setConfirmFallbackModal(null);
                resolve(false);
              },
            });
          });
        }

        if (!userConfirmedFallback) {
          d.setLoading(false);
          d.setGenerationStatus(null);
          d.setMessages(
            oldAssistantMessage
              ? ([...priorMessagesForRegen(priorMessages, userMessage), oldAssistantMessage] as Message[])
              : priorMessages,
          );

          if (priorMessages.length > 0) {
            d.setEditingGame(true);
          } else {
            d.setEditingGame(false);
            d.setNewGameOpen(true);
          }

          d.setOptPanel("guide");
          setTimeout(() => {
            const panel = document.getElementById("opt-panel-guide");
            if (panel) {
              panel.scrollIntoView({ behavior: "smooth", block: "center" });
              const urlInput = panel.querySelector("input[type='url']") as HTMLInputElement | null;
              if (urlInput) {
                urlInput.focus();
              }
            }
          }, 100);
          return;
        }

        const response = await fetch("/api/solve", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "X-Trace-Id": traceId,
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          },
          signal: controller.signal,
          body: JSON.stringify({
            chatId: activeId,
            game: d.game,
            platform: d.platform,
            question,
            history,
            preferredUrls: guideUrls,
            images,
            spoilerPrefs: d.spoilerPrefs,
            playerName: d.user ? displayNameFromMetadata(d.user.user_metadata) : "",
            userId: d.user?.id ?? null,
            bundlePrefs: buildBundlePrefsBody(guideUrls, d.guideBundleMeta),
            retryContext,
          }),
        });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answerData: any = null;
        let streamError: Error | null = null;

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamStarted = true;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              if (!part.trim()) continue;
              const eventMatch = part.match(/^event:\s*([^\n]+)/m);
              const dataMatch = part.match(/^data:\s*([^\n]+)/m);
              if (eventMatch && dataMatch) {
                const eventName = eventMatch[1].trim();
                const payloadStr = dataMatch[1].trim();
                try {
                  const payload = JSON.parse(payloadStr);
                  if (eventName === "status" && payload.text) {
                    if (activeId) d.backgroundStatusRef.current[activeId] = payload.text;
                    if (activeId === d.activeChatIdRef.current || !activeId) {
                      d.setGenerationStatus(payload.text);
                    }
                  } else if (eventName === "prediction_id" && payload.id) {
                    if (activeId) d.predictionIdsRef.current[activeId] = payload.id;
                  } else if (eventName === "context_ready") {
                    currentContext = payload;
                  } else if (eventName === "result") {
                    answerData = payload;
                  } else if (eventName === "error" && payload.error) {
                    streamError = new Error(payload.error);
                  }
                } catch (e) {
                  // Ignore parsing errors for incomplete chunks
                }
              }
            }
          }
        }

        if (streamError) throw streamError;

        const data: unknown = answerData;
        if (
          !response.ok ||
          !data ||
          typeof data !== "object" ||
          !("answer" in data) ||
          typeof data.answer !== "string"
        ) {
          throw new Error("Couldn't build a guide. Please try again.");
        }

        const sources =
          "sources" in data && Array.isArray(data.sources)
            ? (data.sources as Source[])
            : [];
        const pipelineType = "pipelineType" in data && typeof data.pipelineType === "string" ? data.pipelineType : undefined;
        let finalToast: string | undefined = undefined;

        if (
          "guideHint" in data &&
          typeof data.guideHint === "string" &&
          data.guideHint &&
          data.guideHint !== ingestResult?.hint
        ) {
          finalToast = data.guideHint;
        }
        if (pipelineType === "fallback_web") {
          const uploadLabel = uploadedSourceGuideLabel(sources);
          if (uploadLabel) {
            finalToast = `Answered from ${uploadLabel.toLowerCase()} + web search`;
          }
        }

        const highlights = coerceHighlights(
          "highlights" in data ? data.highlights : undefined,
        );
        const spoilers = coerceSpoilers("spoilers" in data ? data.spoilers : undefined);

        const variantBody = buildAssistantVariantBody({
          content: data.answer as string,
          sources,
          highlights,
          spoilers,
          pipelineType,
          spoilerMajor: d.spoilerPrefs.major,
        });

        const nextMessages = buildTurnMessagesWithAssistant({
          priorMessages,
          userMessage,
          oldAssistantMessage,
          variantBody,
        }) as Message[];

        if (activeId) {
          d.backgroundMessagesRef.current[activeId] = nextMessages;
          d.backgroundLoadingRef.current[activeId] = false;
          d.backgroundStatusRef.current[activeId] = null;
        }
        if (activeId === d.activeChatIdRef.current || !activeId) {
          d.setMessages(nextMessages);
        }
        d.conversationGame.current = d.game;
        if (activeId) delete d.abortRefs.current[activeId];
        succeeded = true;
        if (activeId === d.activeChatIdRef.current || !activeId) {
          d.setLoading(false);
          d.setGenerationStatus(null);
          if (finalToast) d.setToast(finalToast);
          else if (ingestResult?.hint) d.setToast(ingestResult.hint);
        }

        const serverPersistsAssistant = serverOwnsAssistantPersist({
          hasUser: Boolean(d.user),
          isTemporary: d.temporary,
          hasChatId: Boolean(activeId),
          hasAuthToken: Boolean(accessToken),
        });

        if (serverPersistsAssistant && activeId) {
          const syncChatId = activeId;
          const supabase = getSupabase();
          if (supabase) {
            void (async () => {
              const synced = await pollUntilMessagesRecovered({
                fetchMessages: async () => {
                  const loaded = await loadThreadMessages(supabase, syncChatId);
                  return loaded.length ? loaded : null;
                },
                optimistic,
              });
              if (synced) {
                const syncedMessages = synced as Message[];
                d.backgroundMessagesRef.current[syncChatId] = syncedMessages;
                if (
                  d.activeChatIdRef.current === syncChatId &&
                  shouldApplySyncedMessages(nextMessages, syncedMessages)
                ) {
                  d.setMessages(syncedMessages);
                }
              } else {
                await persistChat(nextMessages, syncChatId);
              }
              void d.loadChats();
            })();
          } else {
            await persistChat(nextMessages, activeId);
            void d.loadChats();
          }
        } else {
          await persistChat(nextMessages, activeId);
          void d.loadChats();
        }
        if (activeId) d.activeChatIdRef.current = activeId;
        // Temporary chat never persists, and images are base64, so no need to clean up Storage.
      } catch (caught) {
        const isNetworkDrop = caught instanceof TypeError && caught.message.toLowerCase().includes("fetch");
        const isServerSidePersistent = Boolean(d.user);
        const isAbort = caught instanceof DOMException && caught.name === "AbortError";

        // If stream never started (e.g. no connection at all, backend down), don't pretend it's in background
        if (!isAbort && isNetworkDrop && isServerSidePersistent && activeId && streamStarted) {
          const msg = "Continuing process...";
          d.backgroundStatusRef.current[activeId] = msg;
          if (d.activeChatIdRef.current === activeId) d.setGenerationStatus(msg);

          const supabase = getSupabase();
          if (supabase) {
             let attempts = 0;
             while (attempts < 150) {
               if (controller.signal.aborted) break;
               await new Promise((res) => setTimeout(res, 2000));
               attempts++;
               if (attempts === 30) {
                 d.backgroundStatusRef.current[activeId] = "Still working in background...";
                 if (d.activeChatIdRef.current === activeId) d.setGenerationStatus("Still working in background...");
               }
               const loaded = await loadThreadMessages(supabase, activeId);
               if (loaded.length && pollRecoveredMessages(optimistic, loaded)) {
                 const msgs = loaded as Message[];
                 d.backgroundMessagesRef.current[activeId] = msgs;
                 d.backgroundLoadingRef.current[activeId] = false;
                 d.backgroundStatusRef.current[activeId] = null;
                 delete d.abortRefs.current[activeId];
                 if (d.activeChatIdRef.current === activeId) {
                   d.setMessages(msgs);
                   d.setLoading(false);
                   d.setGenerationStatus(null);
                 }
                 void d.loadChats();
                 succeeded = true;
                 return;
               }
             }
             if (attempts >= 150) {
               // Timeout: leave the optimistic message in place and stop spinning
               succeeded = true;
               return;
             }
          }
        }

        if (activeId) {
          d.backgroundMessagesRef.current[activeId] = priorMessages;
          d.backgroundLoadingRef.current[activeId] = false;
          delete d.abortRefs.current[activeId];
          if (!d.temporary) {
            await persistChat(priorMessages, activeId).catch(() => {});
          }
        }
        if (d.activeChatIdRef.current === activeId) {
          d.setMessages(
            oldAssistantMessage
              ? ([...priorMessagesForRegen(priorMessages, userMessage), oldAssistantMessage] as Message[])
              : priorMessages,
          );
          d.setLoading(false);
          if (!isAbort) {
            d.setError(
              caught instanceof Error ? caught.message : "An unknown error occurred.",
            );
            d.setRetryAction(() => () => void runTurn(question, priorMessages, activeId, images, currentContext));
          }
        }
      } finally {
        if (activeId && !succeeded) {
          d.backgroundLoadingRef.current[activeId] = false;
          delete d.abortRefs.current[activeId];
        }
        if (d.activeChatIdRef.current === activeId) {
          d.setLoading(false);
          if (succeeded) d.setGenerationStatus(null);
        }
        // Answer's in: hand focus back to the composer on desktop so a follow-up
        // can be typed right away. Skip on touch-primary devices — focus pops the
        // keyboard over the answer. rAF waits for the textarea to un-disable.
        if (succeeded) {
          const touchPrimary = window.matchMedia?.(
            "(pointer: coarse) and (hover: none)",
          )?.matches;
          if (!touchPrimary) {
            requestAnimationFrame(() => d.composerRef.current?.focus());
          }
        }
      }
    }

    function stopGeneration() {
    const d = depsRef.current;
      if (d.activeChatIdRef.current) {
        const activeId = d.activeChatIdRef.current;
        d.abortRefs.current[activeId]?.abort();

        const pid = d.predictionIdsRef.current[activeId];
        if (pid) {
          fetch("/api/solve/cancel", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ predictionId: pid })
          }).catch(console.error);
        }
      }
    }

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const d = depsRef.current;
      event.preventDefault();
      if (d.editingIndex !== null) {
        await saveEdit(d.editingIndex);
        return;
      }
      const question = d.input.trim();
      if (!d.game.trim() || question.length < 2 || d.loading) return;

      const switching =
        d.messages.length > 0 &&
        d.normGame(d.game) !== d.normGame(d.conversationGame.current);
      const priorMessages = switching ? [] : d.messages;
      const targetChatId = switching ? null : d.activeChatIdRef.current;
      if (switching) d.setActiveChatId(null);

      d.setInput("");
      d.setLoading(true); // cover the upload gap before runTurn takes over
      const images = await d.uploadMessageImages();
      d.clearPendingImages();
      await runTurn(question, priorMessages, targetChatId, images);
    }

    function startEdit(index: number) {
    const d = depsRef.current;
      if (d.loading) return;
      d.setEditingIndex(index);
      const msg = d.messages[index];
      d.setInput(msg.content);
      if (msg.images && msg.images.length > 0) {
        d.setPendingImages(msg.images.map((url) => ({ preview: url, isExisting: true })));
      } else {
        d.setPendingImages([]);
      }
      setTimeout(() => {
        d.composerRef.current?.focus();
        document.getElementById(`msg-${index}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    }

    function cancelEdit() {
    const d = depsRef.current;
      d.setEditingIndex(null);
      d.setInput("");
      d.clearPendingImages();
    }

    // Editing/retrying discards the dropped turns' attached images. Confirm first
    // when there's actually an image to lose; plain text edits stay instant.
    async function confirmDropImages(dropped: Message[]) {
    const d = depsRef.current;
      const count = dropped.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (count === 0) return true;
      return d.askConfirm(
        `This action will discard ${count} attached image${count > 1 ? "s" : ""} from the messages after this one. Continue?`,
      );
    }

    async function saveEdit(index: number) {
    const d = depsRef.current;
      const text = d.input.trim();
      if (text.length < 2 || d.loading) return;

      const dropped = d.messages.slice(index + 2);
      if (!(await confirmDropImages(dropped))) return;

      d.setLoading(true);
      const newImages = await d.uploadMessageImages();
      await d.deleteMessageImages(dropped);

      const oldImages = d.messages[index].images || [];
      const removedImages = oldImages.filter(url => !newImages.includes(url));
      if (removedImages.length > 0 && !d.temporary) {
        await d.deleteMessageImages([{ role: "user", content: "", images: removedImages }]);
      }

      d.clearPendingImages();
      d.setInput("");
      d.setEditingIndex(null);
      const oldAssistantMessage = d.messages.length > index + 1 && d.messages[index + 1].role === "assistant" ? d.messages[index + 1] : undefined;
      await runTurn(text, d.messages.slice(0, index), d.activeChatIdRef.current, newImages, null, oldAssistantMessage);
    }

    async function retry(index: number) {
    const d = depsRef.current;
      if (d.loading || index < 1 || d.messages[index - 1].role !== "user") return;
      const question = d.messages[index - 1].content;
      const existingImages = d.messages[index - 1].images || [];
      const dropped = d.messages.slice(index + 1);
      if (!(await confirmDropImages(dropped))) return;
      await d.deleteMessageImages(dropped);
      await runTurn(question, d.messages.slice(0, index), d.activeChatIdRef.current, existingImages, null, d.messages[index]);
    }

    function onNavigateVariant(msgIndex: number, variantIndex: number) {
    const d = depsRef.current;
      d.setMessages((prev) => {
        const next = [...prev];
        const msg = next[msgIndex];
        if (!msg || msg.role !== "assistant" || !msg.variants || variantIndex < 0 || variantIndex >= msg.variants.length) return next;

        const variant = msg.variants[variantIndex];
        next[msgIndex] = {
          ...msg,
          content: variant.content,
          sources: variant.sources,
          highlights: variant.highlights,
          spoilers: variant.spoilers,
          pipelineType: variant.pipelineType,
          activeVariantIndex: variantIndex,
        };

        if (d.activeChatIdRef.current) {
          void persistChat(next, d.activeChatIdRef.current).catch(() => {});
        }
        return next;
      });
    }

  return {
    persistChat,
    runTurn,
    stopGeneration,
    handleSubmit,
    startEdit,
    cancelEdit,
    saveEdit,
    retry,
    onNavigateVariant,
  };
}
