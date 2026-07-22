import {
  buildAssistantVariantBody,
  buildTurnMessagesWithAssistant,
  pollUntilMessagesRecovered,
  serverOwnsAssistantPersist,
  shouldApplySyncedMessages,
} from "@/lib/chat-persist.js";
import { priorMessagesForRegen, threadSyncModeForTurn } from "@/lib/chat-thread.js";
import {
  WRITING_ANSWER_PLACEHOLDER,
  snapshotAssistantVariants,
} from "@/lib/chat-messages.js";
import { uploadedSourceGuideLabel } from "@/lib/chat-message-ui.js";
import { buildBundlePrefsBody } from "@/lib/guide-card-ui.js";
import { coerceHighlights, coerceSpoilers } from "@/lib/highlights.js";
import { displayNameFromMetadata } from "@/lib/profile.js";
import { getSupabase } from "@/lib/supabase";
import type { ChatTurnDeps } from "./chat-turn-deps";
import {
  normalizedGuideUrls,
  runGuideIngestForTurn,
  urlsNeedingIngestForTurn,
} from "./guide-turn-ingest";
import { readSolveStream } from "./solve-stream";
import { pollNetworkDropRecovery, tryRecoverPersistedAnswer } from "./turn-recovery";
import type { Message, RetryContext, Source, ThreadSyncMode } from "./types";

export type RunTurnFn = (
  question: string,
  priorMessages: Message[],
  targetChatId: string | null,
  images?: string[],
  retryContext?: RetryContext,
  oldAssistantMessage?: Message,
) => Promise<void>;

type PersistFn = (
  nextMessages: Message[],
  targetChatId: string | null,
  options?: { sync?: ThreadSyncMode },
) => Promise<string | null>;

type ExecuteChatTurnParams = {
  deps: ChatTurnDeps;
  persistChat: PersistFn;
  awaitPreSolveThreadSync: (
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
    messages: Message[],
    mode?: ThreadSyncMode,
  ) => Promise<void>;
  fetchResolvedThread: (
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
  ) => Promise<Message[]>;
  rerunTurn: RunTurnFn;
  question: string;
  priorMessages: Message[];
  targetChatId: string | null;
  images?: string[];
  retryContext?: RetryContext;
  oldAssistantMessage?: Message;
};

export async function executeChatTurn({
  deps: d,
  persistChat,
  awaitPreSolveThreadSync,
  fetchResolvedThread,
  rerunTurn,
  question,
  priorMessages,
  targetChatId,
  images = [],
  retryContext = null,
  oldAssistantMessage,
}: ExecuteChatTurnParams) {
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
  const guideUrls = normalizedGuideUrls(d.preferredUrls);
  const history = priorMessages.slice(-10).map(({ role, content }) => ({ role, content }));
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
          variants: snapshotAssistantVariants(
            oldAssistantMessage,
          ) as NonNullable<Message["variants"]>,
        },
      ]
    : [...priorMessages, userMessage];

  const syncMode = threadSyncModeForTurn(priorMessages, d.messages) as ThreadSyncMode;

  d.setMessages(optimistic);
  let activeId = targetChatId;
  if (!d.temporary) {
    activeId = (await persistChat(optimistic, targetChatId, { sync: syncMode })) || activeId;
  }
  if (activeId) d.activeChatIdRef.current = activeId;

  if (activeId) {
    d.backgroundMessagesRef.current[activeId] = optimistic;
    d.backgroundLoadingRef.current[activeId] = true;
    d.backgroundStatusRef.current[activeId] = null;
  }

  const controller = new AbortController();
  if (activeId) d.abortRefs.current[activeId] = controller;

  const ingestPromise = urlsNeedingIngestForTurn(d, guideUrls).length
    ? runGuideIngestForTurn({ deps: d, guideUrls, traceId, signal: controller.signal })
    : null;
  let streamStarted = false;
  let currentContext: RetryContext = retryContext;

  try {
    const supabase = getSupabase();
    let accessToken = "";
    if (supabase) {
      const { data: sessionData } = await supabase.auth.getSession();
      accessToken = sessionData.session?.access_token || "";
    }

    const ingestResult = ingestPromise ? await ingestPromise : null;
    let userConfirmedFallback = true;
    if (ingestResult?.hint && ingestResult.hint.includes("Couldn't read")) {
      userConfirmedFallback = await new Promise<boolean>((resolve) => {
        d.setConfirmFallbackModal({
          hint: ingestResult.hint,
          hasIndexedGuides: ingestResult.hasIndexedGuides,
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
          ? ([
              ...priorMessagesForRegen(priorMessages, userMessage),
              oldAssistantMessage,
            ] as Message[])
          : priorMessages,
      );
      if (priorMessages.length > 0) d.setEditingGame(true);
      else {
        d.setEditingGame(false);
        d.setNewGameOpen(true);
      }
      d.setOptPanel("guide");
      setTimeout(() => {
        document.getElementById("opt-panel-guide")?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        const urlInput = document.querySelector(
          "#opt-panel-guide input[type='url']",
        ) as HTMLInputElement | null;
        urlInput?.focus();
      }, 100);
      return;
    }

    if (supabase && activeId && !d.temporary && d.user) {
      await awaitPreSolveThreadSync(supabase, activeId, optimistic, syncMode);
    }

    const response = await fetch("/api/solve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": traceId,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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
    let answerData = null;
    let streamError: Error | null = null;

    if (reader) {
      const streamResult = await readSolveStream(reader, {
        onStatus: (text) => {
          if (activeId) d.backgroundStatusRef.current[activeId] = text;
          if (activeId === d.activeChatIdRef.current || !activeId) {
            d.setGenerationStatus(text);
          }
        },
        onPredictionId: (id) => {
          if (activeId) d.predictionIdsRef.current[activeId] = id;
        },
      });
      streamStarted = streamResult.streamStarted;
      answerData = streamResult.answerData;
      streamError = streamResult.streamError;
      if (streamResult.retryContext) currentContext = streamResult.retryContext;
    }

    if (streamError) throw streamError;

    const data = answerData;
    if (!response.ok || !data || typeof data.answer !== "string") {
      throw new Error("Couldn't build a guide. Please try again.");
    }

    const sources = Array.isArray(data.sources) ? (data.sources as Source[]) : [];
    const pipelineType = typeof data.pipelineType === "string" ? data.pipelineType : undefined;
    let finalToast: string | undefined;
    if (data.guideHint && data.guideHint !== ingestResult?.hint) {
      finalToast = data.guideHint;
    }
    if (pipelineType === "fallback_web") {
      const uploadLabel = uploadedSourceGuideLabel(sources);
      if (uploadLabel) {
        finalToast = `Answered from ${uploadLabel.toLowerCase()} + web search`;
      }
    }

    const variantBody = buildAssistantVariantBody({
      content: data.answer,
      sources,
      highlights: coerceHighlights(data.highlights),
      spoilers: coerceSpoilers(data.spoilers),
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
      const syncSupabase = getSupabase();
      if (syncSupabase) {
        void (async () => {
          const synced = await pollUntilMessagesRecovered({
            fetchMessages: async () => {
              const loaded = await fetchResolvedThread(syncSupabase, syncChatId);
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
  } catch (caught) {
    const isNetworkDrop =
      caught instanceof TypeError && caught.message.toLowerCase().includes("fetch");
    const isAbort = caught instanceof DOMException && caught.name === "AbortError";
    const recoveryRefs = {
      backgroundMessagesRef: d.backgroundMessagesRef,
      backgroundLoadingRef: d.backgroundLoadingRef,
      backgroundStatusRef: d.backgroundStatusRef,
      abortRefs: d.abortRefs,
      activeChatIdRef: d.activeChatIdRef,
    };
    const recoverySetters = {
      setMessages: d.setMessages,
      setLoading: d.setLoading,
      setGenerationStatus: d.setGenerationStatus,
      setError: d.setError,
      loadChats: d.loadChats,
    };

    if (!isAbort && isNetworkDrop && d.user && activeId && streamStarted) {
      const recovered = await pollNetworkDropRecovery(
        activeId,
        optimistic,
        controller,
        fetchResolvedThread,
        recoveryRefs,
        recoverySetters,
      );
      if (recovered) {
        succeeded = true;
        return;
      }
    }

    if (!isAbort && !d.temporary && activeId && d.user) {
      const recovered = await tryRecoverPersistedAnswer(
        activeId,
        optimistic,
        fetchResolvedThread,
        recoveryRefs,
        recoverySetters,
      );
      if (recovered) {
        succeeded = true;
        return;
      }
    }

    if (activeId) {
      d.backgroundMessagesRef.current[activeId] = priorMessages;
      d.backgroundLoadingRef.current[activeId] = false;
      delete d.abortRefs.current[activeId];
      if (!d.temporary) {
        await persistChat(priorMessages, activeId, { sync: "full" }).catch(() => {});
      }
    }
    if (d.activeChatIdRef.current === activeId) {
      d.setMessages(
        oldAssistantMessage
          ? ([
              ...priorMessagesForRegen(priorMessages, userMessage),
              oldAssistantMessage,
            ] as Message[])
          : priorMessages,
      );
      d.setLoading(false);
      if (!isAbort) {
        d.setError(
          caught instanceof Error ? caught.message : "An unknown error occurred.",
        );
        d.setRetryAction(
          () => () =>
            void rerunTurn(
              question,
              priorMessages,
              activeId,
              images,
              currentContext,
              oldAssistantMessage,
            ),
        );
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
    if (succeeded) {
      const touchPrimary = window.matchMedia?.("(pointer: coarse) and (hover: none)")?.matches;
      if (!touchPrimary) {
        requestAnimationFrame(() => d.composerRef.current?.focus());
      }
    }
  }
}
