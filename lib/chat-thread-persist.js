import { coerceMessages } from "./chat-messages.js";
import {
  buildMessagesFromNormalized,
  derivePersistContext,
  pairMessagesIntoTurns,
  pickRicherThread,
  threadReadyForAssistantMerge,
  variantRowsFromPersistedAssistant,
} from "./chat-thread.js";
import { compareThreadSources } from "./chat-thread-audit.js";

/**
 * Load messages from normalized tables. Returns null when no rows exist.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 */
export async function fetchNormalizedThread(supabase, chatId) {
  const { data: turns, error: turnError } = await supabase
    .from("chat_turns")
    .select("id, turn_index, user_content, user_images")
    .eq("chat_id", chatId)
    .order("turn_index", { ascending: true });

  if (turnError || !turns?.length) return null;

  const turnIds = turns.map((turn) => turn.id);
  const [{ data: responses }, { data: states }] = await Promise.all([
    supabase
      .from("chat_responses")
      .select(
        "turn_id, variant_index, content, sources, highlights, spoilers, pipeline_type",
      )
      .in("turn_id", turnIds),
    supabase
      .from("chat_turn_state")
      .select("turn_id, active_variant_index")
      .in("turn_id", turnIds),
  ]);

  return buildMessagesFromNormalized(turns, responses || [], states || []);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 */
async function fetchLegacyMessagesCache(supabase, chatId) {
  const { data, error } = await supabase
    .from("chats")
    .select("messages")
    .eq("id", chatId)
    .single();
  if (error || !data) return [];
  return coerceMessages(data.messages);
}

/**
 * Signed-in read path: normalized + legacy JSONB cache; richer source wins.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ id: string; messages?: unknown }} chat
 */
export async function resolveThreadMessages(supabase, chat) {
  const normalized = await fetchNormalizedThread(supabase, chat.id);
  let legacy = coerceMessages(chat.messages);
  if (!legacy.length) {
    legacy = await fetchLegacyMessagesCache(supabase, chat.id);
  }
  return pickRicherThread(normalized, legacy);
}

/**
 * Messages array for server `after()` merge: normalized when it has the
 * in-flight user turn, else JSONB cache, else richer of the two.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 */
export async function loadMessagesForServerMerge(supabase, chatId) {
  const [normalized, legacy] = await Promise.all([
    fetchNormalizedThread(supabase, chatId),
    fetchLegacyMessagesCache(supabase, chatId),
  ]);
  return selectMessagesForServerMerge(normalized, legacy);
}

/**
 * Sync normalized tables from a UI message array (client persist + server save).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {unknown} rawMessages
 * @param {string} [traceId]
 * @param {{ mode?: "full" | "tail" }} [options]
 */
export async function syncThreadFromMessages(
  supabase,
  chatId,
  rawMessages,
  traceId,
  options = {},
) {
  const messages = coerceMessages(rawMessages);
  if (!messages.length) return { ok: false, reason: "empty_messages" };
  if (options.mode === "tail") {
    return syncTailTurnFromMessages(supabase, chatId, messages, traceId);
  }
  return syncAllTurnsFromMessages(supabase, chatId, messages, traceId);
}

/**
 * Index of the last paired turn in a message array (for tail sync).
 *
 * @param {unknown} rawMessages
 */
export function tailTurnIndexFromMessages(rawMessages) {
  const turns = pairMessagesIntoTurns(coerceMessages(rawMessages));
  return turns.length > 0 ? turns.length - 1 : -1;
}

/**
 * Pure merge-source picker for server `after()` (testable without Supabase).
 *
 * @param {Array<Record<string, unknown>> | null | undefined} normalized
 * @param {Array<Record<string, unknown>>} legacy
 */
export function selectMessagesForServerMerge(normalized, legacy) {
  const normalizedRows = normalized ?? [];
  if (threadReadyForAssistantMerge(normalizedRows)) {
    return [...normalizedRows];
  }
  if (threadReadyForAssistantMerge(legacy)) {
    return [...legacy];
  }
  return [...pickRicherThread(normalizedRows, legacy)];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {number} turnIndex
 * @param {{ user: Record<string, unknown>; assistant: Record<string, unknown> | null }} paired
 * @param {string | undefined} traceId
 * @param {boolean} isLastTurn
 */
async function upsertPairedTurn(
  supabase,
  chatId,
  turnIndex,
  { user, assistant },
  traceId,
  isLastTurn,
) {
  const userImages = Array.isArray(user.images)
    ? user.images.filter((url) => typeof url === "string")
    : [];

  const { data: turn, error: turnError } = await supabase
    .from("chat_turns")
    .upsert(
      {
        chat_id: chatId,
        turn_index: turnIndex,
        user_content: String(user.content),
        user_images: userImages,
      },
      { onConflict: "chat_id,turn_index" },
    )
    .select("id")
    .single();

  if (turnError || !turn) {
    return { ok: false, reason: "turn_upsert", error: turnError };
  }

  if (!assistant) {
    const { error: clearError } = await supabase
      .from("chat_responses")
      .delete()
      .eq("turn_id", turn.id);
    if (clearError) {
      return { ok: false, reason: "response_clear", error: clearError };
    }
    await supabase.from("chat_turn_state").delete().eq("turn_id", turn.id);
    return { ok: true };
  }

  const variantRows = variantRowsFromPersistedAssistant(
    assistant,
    isLastTurn ? traceId : undefined,
  );
  if (!variantRows.length) {
    return { ok: true };
  }

  const { error: responseError } = await supabase.from("chat_responses").upsert(
    variantRows.map((row) => ({
      turn_id: turn.id,
      variant_index: row.variant_index,
      content: String(row.body.content),
      sources: row.body.sources ?? null,
      highlights: row.body.highlights ?? null,
      spoilers: row.body.spoilers ?? null,
      pipeline_type:
        typeof row.body.pipelineType === "string" ? row.body.pipelineType : null,
      trace_id: row.trace_id,
    })),
    { onConflict: "turn_id,variant_index" },
  );

  if (responseError) {
    return { ok: false, reason: "response_upsert", error: responseError };
  }

  const { error: pruneError } = await supabase
    .from("chat_responses")
    .delete()
    .eq("turn_id", turn.id)
    .gte("variant_index", variantRows.length);
  if (pruneError) {
    return { ok: false, reason: "response_prune", error: pruneError };
  }

  const activeIdx =
    typeof assistant.activeVariantIndex === "number"
      ? assistant.activeVariantIndex
      : variantRows.length - 1;

  await supabase.from("chat_turn_state").upsert(
    {
      turn_id: turn.id,
      active_variant_index: activeIdx,
    },
    { onConflict: "turn_id" },
  );

  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {number} turnCount
 */
async function pruneOrphanTurns(supabase, chatId, turnCount) {
  await supabase
    .from("chat_turns")
    .delete()
    .eq("chat_id", chatId)
    .gte("turn_index", turnCount);
}

/**
 * Upsert only the last paired turn; prune rows past the message tail.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {Array<Record<string, unknown>>} messages
 * @param {string | undefined} traceId
 */
export async function syncTailTurnFromMessages(supabase, chatId, messages, traceId) {
  const turns = pairMessagesIntoTurns(messages);
  if (!turns.length) return { ok: false, reason: "empty_messages" };

  const tailIndex = turns.length - 1;
  const synced = await upsertPairedTurn(
    supabase,
    chatId,
    tailIndex,
    turns[tailIndex],
    traceId,
    true,
  );
  if (!synced.ok) return synced;

  await pruneOrphanTurns(supabase, chatId, turns.length);
  return { ok: true, mode: "tail", turnIndex: tailIndex };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {Array<Record<string, unknown>>} messages
 * @param {string | undefined} traceId
 */
async function syncAllTurnsFromMessages(supabase, chatId, messages, traceId) {
  const turns = pairMessagesIntoTurns(messages);
  const lastTurnIndex = turns.length - 1;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const synced = await upsertPairedTurn(
      supabase,
      chatId,
      turnIndex,
      turns[turnIndex],
      traceId,
      turnIndex === lastTurnIndex,
    );
    if (!synced.ok) return synced;
  }

  await pruneOrphanTurns(supabase, chatId, turns.length);

  return { ok: true, mode: "full", turnCount: turns.length };
}

/**
 * Persist assistant variants to normalized tables; keep the full merged thread as cache.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   chatId: string;
 *   messages: Array<Record<string, unknown>>;
 *   variantBody: Record<string, unknown>;
 *   traceId?: string;
 * }} input
 */
export async function persistAssistantResponse(supabase, input) {
  const { chatId, messages, traceId } = input;
  const context = derivePersistContext(messages);
  if (!context) return { ok: false, reason: "no_context" };

  const synced = await syncAllTurnsFromMessages(supabase, chatId, messages, traceId);
  if (!synced.ok) return synced;

  const cache = coerceMessages(messages);
  if (!cache.length) {
    return { ok: false, reason: "cache_empty" };
  }

  const { error: cacheError } = await supabase
    .from("chats")
    .update({ messages: cache, updated_at: new Date().toISOString() })
    .eq("id", chatId);

  if (cacheError) {
    return { ok: false, reason: "cache_update", error: cacheError };
  }

  return { ok: true, messages: cache };
}

/**
 * Backfill normalized tables from a legacy messages array (Phase 3 migration).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {unknown} rawMessages
 * @param {{ dryRun?: boolean; repairCache?: boolean; traceId?: string }} [options]
 */
export async function backfillChatFromMessages(supabase, chatId, rawMessages, options = {}) {
  const messages = coerceMessages(rawMessages);
  if (!messages.length) {
    return { ok: false, reason: "empty_messages" };
  }

  const turnCount = pairMessagesIntoTurns(messages).length;
  if (options.dryRun) {
    return { ok: true, dryRun: true, chatId, turnCount, messageCount: messages.length };
  }

  const synced = await syncAllTurnsFromMessages(supabase, chatId, messages, options.traceId);
  if (!synced.ok) return { ...synced, chatId };

  if (options.repairCache) {
    const rebuilt = await fetchNormalizedThread(supabase, chatId);
    if (rebuilt?.length) {
      const { error } = await supabase
        .from("chats")
        .update({ messages: rebuilt, updated_at: new Date().toISOString() })
        .eq("id", chatId);
      if (error) {
        return { ok: false, reason: "cache_repair", error, chatId };
      }
    }
  }

  return { ok: true, chatId, turnCount, messageCount: messages.length };
}

/**
 * Verify one chat: legacy JSONB vs normalized rebuild.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ id: string; messages?: unknown }} chat
 */
export async function verifyChatThread(supabase, chat) {
  const legacy = coerceMessages(chat.messages);
  const normalized = await fetchNormalizedThread(supabase, chat.id);
  const audit = compareThreadSources(legacy, normalized);
  return { chatId: chat.id, ...audit };
}
