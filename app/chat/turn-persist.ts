import type { RefObject } from "react";
import {
  resolveThreadMessages,
  syncThreadFromMessages,
} from "@/lib/chat-thread-persist.js";
import { guideUrlsPayload } from "@/lib/guide-urls.js";
import { getSupabase } from "@/lib/supabase";
import { loadLocalGames, upsertLocalGame } from "@/lib/local-games.js";
import type { ChatTurnDeps } from "./chat-turn-deps";
import type { Message, ThreadSyncMode } from "./types";

type SyncResult = { ok: boolean; reason?: string; error?: unknown };

function logThreadSyncFailure(
  chatId: string,
  label: string,
  result?: SyncResult,
  err?: unknown,
) {
  if (result && !result.ok) {
    console.warn(`[chat-thread] ${label}`, {
      chatId,
      reason: result.reason,
      error: result.error,
    });
    return;
  }
  if (err) {
    console.warn(`[chat-thread] ${label}`, { chatId, err });
  }
}

export function createTurnPersist(depsRef: RefObject<ChatTurnDeps>) {
  function scheduleThreadSync(
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
    messages: Message[],
    mode: ThreadSyncMode = "tail",
  ) {
    void syncThreadFromMessages(supabase, chatId, messages, undefined, { mode })
      .then((result) => logThreadSyncFailure(chatId, "sync failed", result))
      .catch((err) => logThreadSyncFailure(chatId, "sync failed", undefined, err));
  }

  async function awaitPreSolveThreadSync(
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
    messages: Message[],
    mode: ThreadSyncMode = "tail",
  ) {
    try {
      const result = await syncThreadFromMessages(supabase, chatId, messages, undefined, {
        mode,
      });
      logThreadSyncFailure(chatId, "pre-solve sync failed", result);
    } catch (err) {
      logThreadSyncFailure(chatId, "pre-solve sync failed", undefined, err);
    }
  }

  async function fetchResolvedThread(
    supabase: NonNullable<ReturnType<typeof getSupabase>>,
    chatId: string,
  ) {
    return (await resolveThreadMessages(supabase, { id: chatId })) as Message[];
  }

  async function persistChat(
    nextMessages: Message[],
    targetChatId: string | null,
    options: { sync?: ThreadSyncMode } = {},
  ) {
    const d = depsRef.current;
    const syncMode = options.sync ?? "tail";
    if (d.temporary) return null;
    const supabase = getSupabase();

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
        scheduleThreadSync(supabase, targetChatId, nextMessages, syncMode);
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
        scheduleThreadSync(supabase, newId, nextMessages, syncMode);
        void d.loadChats();
      }
      return newId;
    } catch (caught) {
      console.error("Failed to save chat:", caught);
      return targetChatId;
    }
  }

  return {
    persistChat,
    scheduleThreadSync,
    awaitPreSolveThreadSync,
    fetchResolvedThread,
  };
}
