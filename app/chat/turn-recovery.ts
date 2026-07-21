import { pollRecoveredMessages } from "@/lib/chat-messages.js";
import { getSupabase } from "@/lib/supabase";
import type { Message } from "./types";

type RecoveryRefs = {
  backgroundMessagesRef: React.RefObject<Record<string, Message[]>>;
  backgroundLoadingRef: React.RefObject<Record<string, boolean>>;
  backgroundStatusRef: React.RefObject<Record<string, string | null>>;
  abortRefs: React.RefObject<Record<string, AbortController>>;
  activeChatIdRef: React.RefObject<string | null>;
};

type RecoverySetters = {
  setMessages: (messages: Message[]) => void;
  setLoading: (value: boolean) => void;
  setGenerationStatus: (value: string | null) => void;
  setError: (value: string) => void;
  loadChats: () => Promise<void>;
};

export async function pollNetworkDropRecovery(
  activeId: string,
  optimistic: Message[],
  controller: AbortController,
  fetchResolvedThread: (
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
  ) => Promise<Message[]>,
  refs: RecoveryRefs,
  setters: RecoverySetters,
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const msg = "Continuing process...";
  refs.backgroundStatusRef.current![activeId] = msg;
  if (refs.activeChatIdRef.current === activeId) {
    setters.setGenerationStatus(msg);
  }

  let attempts = 0;
  while (attempts < 150) {
    if (controller.signal.aborted) break;
    await new Promise((res) => setTimeout(res, 2000));
    attempts++;
    if (attempts === 30) {
      refs.backgroundStatusRef.current![activeId] = "Still working in background...";
      if (refs.activeChatIdRef.current === activeId) {
        setters.setGenerationStatus("Still working in background...");
      }
    }
    const loaded = await fetchResolvedThread(supabase, activeId);
    if (loaded.length && pollRecoveredMessages(optimistic, loaded)) {
      refs.backgroundMessagesRef.current![activeId] = loaded;
      refs.backgroundLoadingRef.current![activeId] = false;
      refs.backgroundStatusRef.current![activeId] = null;
      delete refs.abortRefs.current![activeId];
      if (refs.activeChatIdRef.current === activeId) {
        setters.setMessages(loaded);
        setters.setLoading(false);
        setters.setGenerationStatus(null);
      }
      void setters.loadChats();
      return true;
    }
  }

  return false;
}

export async function tryRecoverPersistedAnswer(
  activeId: string,
  optimistic: Message[],
  fetchResolvedThread: (
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
  ) => Promise<Message[]>,
  refs: RecoveryRefs,
  setters: RecoverySetters,
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  const loaded = await fetchResolvedThread(supabase, activeId);
  if (!loaded.length || !pollRecoveredMessages(optimistic, loaded)) {
    return false;
  }

  refs.backgroundMessagesRef.current![activeId] = loaded;
  refs.backgroundLoadingRef.current![activeId] = false;
  refs.backgroundStatusRef.current![activeId] = null;
  delete refs.abortRefs.current![activeId];
  if (refs.activeChatIdRef.current === activeId) {
    setters.setMessages(loaded);
    setters.setLoading(false);
    setters.setGenerationStatus(null);
    setters.setError("");
  }
  void setters.loadChats();
  return true;
}
