import { coerceMessages } from "./chat-messages.js";
import {
  buildMessagesFromNormalized,
  derivePersistContext,
  pairMessagesIntoTurns,
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
 * Load thread messages from normalized tables (signed-in source of truth).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 */
export async function loadThreadMessages(supabase, chatId) {
  const normalized = await fetchNormalizedThread(supabase, chatId);
  return normalized ?? [];
}

/**
 * Signed-in read path: normalized tables only (Phase 3 cutover).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ id: string }} chat
 */
export async function resolveThreadMessages(supabase, chat) {
  return loadThreadMessages(supabase, chat.id);
}

/**
 * Sync normalized tables from a UI message array (client persist + server save).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} chatId
 * @param {unknown} rawMessages
 * @param {string} [traceId]
 */
export async function syncThreadFromMessages(supabase, chatId, rawMessages, traceId) {
  const messages = coerceMessages(rawMessages);
  if (!messages.length) return { ok: false, reason: "empty_messages" };
  return syncAllTurnsFromMessages(supabase, chatId, messages, traceId);
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
    const { user, assistant } = turns[turnIndex];

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

    if (!assistant) continue;

    const isLastTurn = turnIndex === lastTurnIndex;
    const variantRows = variantRowsFromPersistedAssistant(
      assistant,
      isLastTurn ? traceId : undefined,
    );
    if (!variantRows.length) continue;

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
  }

  await supabase
    .from("chat_turns")
    .delete()
    .eq("chat_id", chatId)
    .gte("turn_index", turns.length);

  return { ok: true };
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
