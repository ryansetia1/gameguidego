import type { RefObject } from "react";
import {
  resolveThreadMessages,
  syncThreadFromMessages,
} from "@/lib/chat-thread-persist.js";
import { guideUrlsPayload } from "@/lib/guide-urls.js";
import {
  chatPayloadWithoutTopicColumns,
  isTopicColumnDbError,
  syncRoomSharedMeta,
  syncSharedMetaToLocalGames,
  upsertChatInList,
} from "@/lib/game-room.js";
import { saveTopicTitleById, titleFromMessages } from "@/lib/topic-title.js";
import { topicSpoilerPayload } from "@/lib/spoiler-prefs.js";
import type { Chat } from "@/lib/supabase";
import { getSupabase } from "@/lib/supabase";
import { loadLocalGames, setLocalGames } from "@/lib/local-games.js";
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

  function bumpChatInState(chatId: string, patch: Partial<Chat> & { id: string }) {
    const d = depsRef.current;
    d.setChats((prev) => {
      const existing = prev.find((row) => row.id === chatId);
      return upsertChatInList(prev, {
        ...(existing ?? {
          id: chatId,
          game: d.game,
          platform: d.platform,
          preferred_guide_url: d.preferredUrls[0] ?? "",
        }),
        ...patch,
        id: chatId,
      } as Chat);
    });
  }

  async function persistChat(
    nextMessages: Message[],
    targetChatId: string | null,
    options: { sync?: ThreadSyncMode; title?: string } = {},
  ) {
    const d = depsRef.current;
    const syncMode = options.sync ?? "tail";
    if (d.temporary) return null;
    const supabase = getSupabase();
    const derivedTitle =
      options.title?.trim() ||
      titleFromMessages(nextMessages) ||
      "";

    if (!supabase || !d.user) {
      const id = targetChatId ?? crypto.randomUUID();
      const sharedMeta = {
        ...guideUrlsPayload(d.preferredUrls),
        cover_url: d.cover.startsWith("blob:") ? "" : d.cover,
        release_year: d.releaseYear,
      };
      const entry = {
        id,
        game: d.game,
        platform: d.platform,
        ...sharedMeta,
        title: derivedTitle,
        ...topicSpoilerPayload(d.topicSpoilerMajor),
        messages: nextMessages,
        updated_at: new Date().toISOString(),
      };
      const rest = loadLocalGames().filter((row) => row.id !== id);
      const synced = syncSharedMetaToLocalGames([entry, ...rest], d.game, d.platform, sharedMeta);
      d.setChats(setLocalGames(synced));
      if (!targetChatId) d.setActiveChatId(id);
      return id;
    }

    const coverUrl = await d.resolveCoverUrl();
    const sharedMeta = {
      ...guideUrlsPayload(d.preferredUrls),
      cover_url: coverUrl,
      release_year: d.releaseYear,
    };
    const payload = {
      game: d.game,
      platform: d.platform,
      ...sharedMeta,
      title: derivedTitle,
      ...topicSpoilerPayload(d.topicSpoilerMajor),
      messages: nextMessages,
      updated_at: new Date().toISOString(),
    };

    try {
      if (targetChatId) {
        const titleRes = await supabase
          .from("chats")
          .select("title")
          .eq("id", targetChatId)
          .maybeSingle();
        if (!titleRes.error) {
          const row = titleRes.data as { title?: string } | null;
          if (row?.title?.trim()) payload.title = row.title;
        }
        let { error: updateError } = await supabase
          .from("chats")
          .update(payload)
          .eq("id", targetChatId);
        if (updateError && isTopicColumnDbError(updateError)) {
          if (derivedTitle) saveTopicTitleById(targetChatId, derivedTitle);
          ({ error: updateError } = await supabase
            .from("chats")
            .update(chatPayloadWithoutTopicColumns(payload))
            .eq("id", targetChatId));
        }
        if (updateError) throw updateError;
        await syncRoomSharedMeta(supabase, d.user.id, d.game, d.platform, sharedMeta);
        scheduleThreadSync(supabase, targetChatId, nextMessages, syncMode);
        bumpChatInState(targetChatId, { id: targetChatId, ...payload, messages: nextMessages });
        void d.loadChats();
        return targetChatId;
      }
      const newId = crypto.randomUUID();
      let { error: insertError } = await supabase
        .from("chats")
        .insert({ ...payload, id: newId, user_id: d.user.id });
      if (insertError && isTopicColumnDbError(insertError)) {
        if (derivedTitle) saveTopicTitleById(newId, derivedTitle);
        ({ error: insertError } = await supabase.from("chats").insert({
          ...chatPayloadWithoutTopicColumns(payload),
          id: newId,
          user_id: d.user.id,
        }));
      }
      if (insertError) throw insertError;
      await syncRoomSharedMeta(supabase, d.user.id, d.game, d.platform, sharedMeta);
      d.setActiveChatId(newId);
      scheduleThreadSync(supabase, newId, nextMessages, syncMode);
      bumpChatInState(newId, { id: newId, ...payload, messages: nextMessages });
      void d.loadChats();
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
