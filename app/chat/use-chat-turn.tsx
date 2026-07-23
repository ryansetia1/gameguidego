"use client";

import type { FormEvent } from "react";
import { useRef } from "react";
import type { ChatTurnDeps } from "./chat-turn-deps";
import { executeChatTurn, type RunTurnFn } from "./execute-chat-turn";
import { createTurnPersist } from "./turn-persist";
import type { Message, RetryContext } from "./types";

export type { ChatTurnDeps } from "./chat-turn-deps";

export function useChatTurn(deps: ChatTurnDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const { persistChat, awaitPreSolveThreadSync, fetchResolvedThread } =
    createTurnPersist(depsRef);

  const runTurnRef = useRef<RunTurnFn>(async () => {});

  runTurnRef.current = async (
    question: string,
    priorMessages: Message[],
    targetChatId: string | null,
    images: string[] = [],
    retryContext: RetryContext = null,
    oldAssistantMessage?: Message,
  ) => {
    await executeChatTurn({
      deps: depsRef.current,
      persistChat,
      awaitPreSolveThreadSync,
      fetchResolvedThread,
      rerunTurn: (...args) => runTurnRef.current(...args),
      question,
      priorMessages,
      targetChatId,
      images,
      retryContext,
      oldAssistantMessage,
    });
  };

  function stopGeneration() {
    const d = depsRef.current;
    if (!d.activeChatIdRef.current) return;
    const activeId = d.activeChatIdRef.current;
    d.abortRefs.current[activeId]?.abort();
    const pid = d.predictionIdsRef.current[activeId];
    if (pid) {
      fetch("/api/solve/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ predictionId: pid }),
      }).catch(console.error);
    }
  }

  // A file/bundle picked but not yet added won't be used this turn — make sure
  // the player didn't think it was uploaded (the silent-guide-loss trap). Shared
  // by new turns, edit-and-send, and retry so none can bypass it.
  async function confirmGuidePending() {
    const d = depsRef.current;
    if (!d.guidePending) return true;
    return d.askConfirm(
      "You picked a guide but haven't added it yet, so it won't be used. Send anyway?",
      "Send anyway",
      false,
    );
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

    if (!(await confirmGuidePending())) return;

    const switching =
      d.messages.length > 0 &&
      d.normGame(d.game) !== d.normGame(d.conversationGame.current);
    const priorMessages = switching ? [] : d.messages;
    const targetChatId = switching ? null : d.activeChatIdRef.current;
    if (switching) d.setActiveChatId(null);

    d.setInput("");
    d.setLoading(true);
    const images = await d.uploadMessageImages();
    d.clearPendingImages();
    await runTurnRef.current(question, priorMessages, targetChatId, images);
  }

  function startEdit(index: number) {
    const d = depsRef.current;
    if (d.loading) return;
    d.setEditingIndex(index);
    const msg = d.messages[index];
    d.setInput(msg.content);
    d.setPendingImages(
      msg.images?.length
        ? msg.images.map((url) => ({ preview: url, isExisting: true }))
        : [],
    );
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

  async function confirmDropFollowups(dropped: Message[], intent: "retry" | "edit") {
    const d = depsRef.current;
    if (dropped.length === 0) return true;
    const imageCount = dropped.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    const parts = [`${dropped.length} later message${dropped.length > 1 ? "s" : ""}`];
    if (imageCount > 0) {
      parts.push(`${imageCount} attached image${imageCount > 1 ? "s" : ""}`);
    }
    const confirmLabel = intent === "retry" ? "Remove & retry" : "Remove & save edit";
    return d.askConfirm(
      `This will remove ${parts.join(" and ")}. Continue?`,
      confirmLabel,
      false,
    );
  }

  async function saveEdit(index: number) {
    const d = depsRef.current;
    const text = d.input.trim();
    if (text.length < 2 || d.loading) return;

    if (!(await confirmGuidePending())) return;

    const dropped = d.messages.slice(index + 2);
    if (!(await confirmDropFollowups(dropped, "edit"))) return;

    d.setLoading(true);
    const newImages = await d.uploadMessageImages();
    await d.deleteMessageImages(dropped);

    const oldImages = d.messages[index].images || [];
    const removedImages = oldImages.filter((url) => !newImages.includes(url));
    if (removedImages.length > 0 && !d.temporary) {
      await d.deleteMessageImages([{ role: "user", content: "", images: removedImages }]);
    }

    d.clearPendingImages();
    d.setInput("");
    d.setEditingIndex(null);
    const oldAssistantMessage =
      d.messages.length > index + 1 && d.messages[index + 1].role === "assistant"
        ? d.messages[index + 1]
        : undefined;
    await runTurnRef.current(
      text,
      d.messages.slice(0, index),
      d.activeChatIdRef.current,
      newImages,
      null,
      oldAssistantMessage,
    );
  }

  async function retry(index: number) {
    const d = depsRef.current;
    if (d.loading || index < 1 || d.messages[index - 1].role !== "user") return;
    if (!(await confirmGuidePending())) return;
    const question = d.messages[index - 1].content;
    const existingImages = d.messages[index - 1].images || [];
    const dropped = d.messages.slice(index + 1);
    if (!(await confirmDropFollowups(dropped, "retry"))) return;
    await d.deleteMessageImages(dropped);
    await runTurnRef.current(
      question,
      d.messages.slice(0, index),
      d.activeChatIdRef.current,
      existingImages,
      null,
      d.messages[index],
    );
  }

  function onNavigateVariant(msgIndex: number, variantIndex: number) {
    const d = depsRef.current;
    const msg = d.messages[msgIndex];
    if (
      !msg ||
      msg.role !== "assistant" ||
      !msg.variants ||
      variantIndex < 0 ||
      variantIndex >= msg.variants.length
    ) {
      return;
    }

    d.variantScrollTargetRef.current = msgIndex;
    const variant = msg.variants[variantIndex]!;
    d.setMessages((prev) => {
      const next = [...prev];
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
        void persistChat(next, d.activeChatIdRef.current, { sync: "full" }).catch(() => {});
      }
      return next;
    });
  }

  return {
    persistChat,
    runTurn: (...args: Parameters<RunTurnFn>) => runTurnRef.current(...args),
    stopGeneration,
    handleSubmit,
    startEdit,
    cancelEdit,
    saveEdit,
    retry,
    onNavigateVariant,
  };
}
