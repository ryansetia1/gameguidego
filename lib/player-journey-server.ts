import type { SupabaseClient } from "@supabase/supabase-js";

import { chunkGuide } from "@/lib/chunk-guide.js";
import { embedTexts } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import { journalUpdateToast } from "@/lib/journal-hints.js";
import { normGameKey } from "@/lib/player-memory.js";
import {
  extractGameDeltaFromChats,
  JOURNAL_AUTO_DAILY_CAP,
  JOURNAL_BODY_MAX,
  JOURNAL_DEBOUNCE_MS,
  JOURNAL_IN_FLIGHT_STALE_MS,
  JOURNAL_MANUAL_PIN_MS,
  journalBodyChars,
  journalUpdateSkipReason,
  maxDeltaTimestamp,
  playerJourneyEnabledFromMetadata,
  utcTodayDate,
} from "@/lib/player-journey.js";
import { synthesizeJournalBody } from "@/lib/player-journey-synthesize";
import { getTraceId, logTraceEvent } from "@/lib/trace";

const CHUNK_INSERT_BATCH = 100;

export type PlayerJourneyRow = {
  user_id: string;
  game_key: string;
  platform: string;
  catalog_game_id: number | null;
  body: string;
  body_chars: number;
  last_updated_at: string | null;
  last_chat_message_at: string | null;
  last_auto_updated_at: string | null;
  auto_update_day: string | null;
  auto_update_count: number;
  manual_save_at: string | null;
  updating_at: string | null;
  last_toast_summary?: string;
  updated_at: string;
};

export type JournalUpdateTrigger = "auto" | "manual" | "edit";

export type JournalUpdateResult =
  | {
      ok: true;
      skipped?: string;
      bodyChars: number;
      chunkCount: number;
      toastSummary: string;
      trigger: JournalUpdateTrigger;
    }
  | { ok: false; error: string; skipped?: string };

export function isPlayerJourneyEnabled(metadata: Record<string, unknown> | undefined) {
  return playerJourneyEnabledFromMetadata(metadata);
}

export async function loadPlayerJourney(
  supabase: SupabaseClient,
  userId: string,
  game: string,
  platform: string,
  catalogGameId?: number | null,
): Promise<PlayerJourneyRow | null> {
  const plat = platform || "";
  if (catalogGameId != null && Number.isFinite(catalogGameId)) {
    const { data, error } = await supabase
      .from("player_journey")
      .select("*")
      .eq("user_id", userId)
      .eq("catalog_game_id", Math.floor(catalogGameId))
      .eq("platform", plat)
      .maybeSingle();
    if (!error && data) return data as PlayerJourneyRow;
  }

  const gameKey = normGameKey(game);
  if (!gameKey) return null;
  const { data, error } = await supabase
    .from("player_journey")
    .select("*")
    .eq("user_id", userId)
    .eq("game_key", gameKey)
    .eq("platform", plat)
    .maybeSingle();
  if (error || !data) return null;
  return data as PlayerJourneyRow;
}

/** Resolve chunk/game_key for RAG when catalog id points at a parked journal row. */
export function journeyGameKeyForOps(
  game: string,
  row: PlayerJourneyRow | null,
): string {
  if (row?.game_key) return row.game_key;
  return normGameKey(game);
}

async function deleteJournalChunks(
  supabase: SupabaseClient,
  userId: string,
  gameKey: string,
  platform: string,
) {
  await supabase
    .from("player_journal_chunks")
    .delete()
    .eq("user_id", userId)
    .eq("game_key", gameKey)
    .eq("platform", platform || "");
}

export async function indexJournalBody(input: {
  supabase: SupabaseClient;
  userId: string;
  gameKey: string;
  platform: string;
  body: string;
  signal?: AbortSignal;
}): Promise<{ chunkCount: number }> {
  const body = input.body.trim().slice(0, JOURNAL_BODY_MAX);
  const indexStart = Date.now();
  await logTraceEvent("journal_index_start", "Indexing journal chunks", undefined, {
    bodyChars: body.length,
  });

  await deleteJournalChunks(input.supabase, input.userId, input.gameKey, input.platform);

  if (!body) {
    await logTraceEvent("journal_index_end", "Journal body empty, chunks cleared", Date.now() - indexStart, {
      chunkCount: 0,
      durationMs: Date.now() - indexStart,
      embedBatches: 0,
    });
    return { chunkCount: 0 };
  }

  const chunks = chunkGuide(body);
  if (!chunks.length) {
    await logTraceEvent("journal_index_end", "No journal chunks produced", Date.now() - indexStart, {
      chunkCount: 0,
      durationMs: Date.now() - indexStart,
      embedBatches: 0,
    });
    return { chunkCount: 0 };
  }

  const embeddings = await embedTexts(chunks, input.signal, {
    game: input.gameKey,
    platform: input.platform,
    userId: input.userId,
    purpose: "ingest",
  });

  const rows = chunks.map((chunk_text, chunk_index) => ({
    user_id: input.userId,
    game_key: input.gameKey,
    platform: input.platform || "",
    chunk_index,
    chunk_text,
    embedding: toVectorString(embeddings[chunk_index]),
  }));

  let embedBatches = 0;
  for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
    const batch = rows.slice(offset, offset + CHUNK_INSERT_BATCH);
    const { error } = await input.supabase.from("player_journal_chunks").insert(batch);
    if (error) throw error;
    embedBatches += 1;
  }

  const durationMs = Date.now() - indexStart;
  await logTraceEvent("journal_index_end", `Indexed ${chunks.length} journal chunk(s)`, durationMs, {
    chunkCount: chunks.length,
    durationMs,
    embedBatches,
  });
  return { chunkCount: chunks.length };
}

async function loadChatsForDelta(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string | null,
) {
  const query = supabase
    .from("chats")
    .select("game, platform, messages, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: true });
  if (sinceIso) query.gte("updated_at", sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function runJournalUpdate(input: {
  supabase: SupabaseClient;
  userId: string;
  game: string;
  platform: string;
  trigger: JournalUpdateTrigger;
  journalReminder?: string;
  journalReminderSummary?: string;
  temporary?: boolean;
  isRetry?: boolean;
  catalogGameId?: number | null;
  bodyOverride?: string;
  signal?: AbortSignal;
}): Promise<JournalUpdateResult> {
  const startedAt = Date.now();
  const existing = await loadPlayerJourney(
    input.supabase,
    input.userId,
    input.game,
    input.platform,
    input.catalogGameId,
  );
  const gameKey = existing?.game_key ?? normGameKey(input.game);
  if (!gameKey) return { ok: false, error: "Invalid game." };
  const sinceIso = existing?.last_chat_message_at ?? null;
  let delta = [];

  try {
    const chats = await loadChatsForDelta(input.supabase, input.userId, sinceIso);
    delta = extractGameDeltaFromChats(chats, sinceIso, input.game, input.platform);
  } catch (error) {
    await logTraceEvent("journal_update_error", "Could not load chats", Date.now() - startedAt, {
      step: "load_chats",
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Could not load chats." };
  }

  const skip = journalUpdateSkipReason({
    trigger: input.trigger,
    temporary: input.temporary,
    isRetry: input.isRetry,
    journalReminder: input.journalReminder,
    row: existing,
    deltaCount: delta.length,
  });

  if (skip) {
    await logTraceEvent("journal_update_skipped", `Journal update skipped: ${skip}`, Date.now() - startedAt, {
      reason: skip,
      trigger: input.trigger,
      game: input.game,
      platform: input.platform,
      userId: input.userId,
    });
    return { ok: true, skipped: skip, bodyChars: journalBodyChars(existing?.body ?? ""), chunkCount: 0, toastSummary: "", trigger: input.trigger };
  }

  await logTraceEvent("journal_update_start", "Journal update started", undefined, {
    trigger: input.trigger,
    game: input.game,
    platform: input.platform,
    userId: input.userId,
    bodyCharsBefore: journalBodyChars(existing?.body ?? ""),
    deltaMessageCount: delta.length,
  });

  const lockNow = new Date().toISOString();
  const { error: lockError } = await input.supabase.from("player_journey").upsert({
    user_id: input.userId,
    game_key: gameKey,
    platform: input.platform || "",
    catalog_game_id: input.catalogGameId ?? existing?.catalog_game_id ?? null,
    body: existing?.body ?? "",
    body_chars: journalBodyChars(existing?.body ?? ""),
    last_chat_message_at: existing?.last_chat_message_at ?? null,
    last_auto_updated_at: existing?.last_auto_updated_at ?? null,
    auto_update_day: existing?.auto_update_day ?? null,
    auto_update_count: existing?.auto_update_count ?? 0,
    manual_save_at: existing?.manual_save_at ?? null,
    updating_at: lockNow,
    updated_at: lockNow,
  });
  if (lockError) {
    await logTraceEvent("journal_update_error", "Could not acquire journal lock", Date.now() - startedAt, {
      step: "lock",
      message: lockError.message,
    });
    return { ok: false, error: "Could not start journal update." };
  }

  try {
    let body = input.bodyOverride?.trim().slice(0, JOURNAL_BODY_MAX) ?? "";
    if (!body && input.trigger !== "edit") {
      const synthesized = await synthesizeJournalBody({
        userId: input.userId,
        game: input.game,
        platform: input.platform,
        existingBody: existing?.body ?? "",
        deltaMessages: delta,
        traceId: getTraceId(),
      });
      if (!synthesized) {
        await input.supabase
          .from("player_journey")
          .update({ updating_at: null, updated_at: new Date().toISOString() })
          .eq("user_id", input.userId)
          .eq("game_key", gameKey)
          .eq("platform", input.platform || "");
        return { ok: false, error: "Could not synthesize journal." };
      }
      body = synthesized.body;
    } else if (!body) {
      body = existing?.body ?? "";
    }

    const watermark = maxDeltaTimestamp(delta);
    const now = new Date().toISOString();
    const today = utcTodayDate();
    const prevDay = existing?.auto_update_day ?? today;
    const prevCount = prevDay === today ? (existing?.auto_update_count ?? 0) : 0;
    const autoCount =
      input.trigger === "auto" ? prevCount + 1 : existing?.auto_update_count ?? 0;
    const autoDay = input.trigger === "auto" ? today : existing?.auto_update_day ?? null;
    const toastSummary = journalUpdateToast({
      summary: input.journalReminderSummary,
      trigger: input.trigger,
      bodyCharsBefore: journalBodyChars(existing?.body ?? ""),
    });

    const { error: saveError } = await input.supabase.from("player_journey").upsert({
      user_id: input.userId,
      game_key: gameKey,
      platform: input.platform || "",
      catalog_game_id: input.catalogGameId ?? existing?.catalog_game_id ?? null,
      body,
      body_chars: journalBodyChars(body),
      last_updated_at: now,
      last_chat_message_at: watermark ?? existing?.last_chat_message_at ?? null,
      last_auto_updated_at: input.trigger === "auto" ? now : existing?.last_auto_updated_at ?? null,
      auto_update_day: autoDay,
      auto_update_count: autoCount,
      manual_save_at:
        input.trigger === "edit" ? now : existing?.manual_save_at ?? null,
      updating_at: null,
      last_toast_summary: toastSummary,
      updated_at: now,
    });
    if (saveError) throw saveError;

    const { chunkCount } = await indexJournalBody({
      supabase: input.supabase,
      userId: input.userId,
      gameKey,
      platform: input.platform || "",
      body,
      signal: input.signal,
    });

    await logTraceEvent("journal_update_complete", "Journal update finished", Date.now() - startedAt, {
      trigger: input.trigger,
      bodyChars: body.length,
      chunkCount,
      totalLatencyMs: Date.now() - startedAt,
    });

    return {
      ok: true,
      bodyChars: body.length,
      chunkCount,
      toastSummary,
      trigger: input.trigger,
    };
  } catch (error) {
    await input.supabase
      .from("player_journey")
      .update({ updating_at: null, updated_at: new Date().toISOString() })
      .eq("user_id", input.userId)
      .eq("game_key", gameKey)
      .eq("platform", input.platform || "");
    await logTraceEvent("journal_update_error", "Journal update failed", Date.now() - startedAt, {
      step: "pipeline",
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Journal update failed." };
  }
}

export async function saveManualJournalEdit(input: {
  supabase: SupabaseClient;
  userId: string;
  game: string;
  platform: string;
  body: string;
  catalogGameId?: number | null;
  signal?: AbortSignal;
}): Promise<JournalUpdateResult> {
  const body = input.body.trim().slice(0, JOURNAL_BODY_MAX);
  return runJournalUpdate({
    supabase: input.supabase,
    userId: input.userId,
    game: input.game,
    platform: input.platform,
    trigger: "edit",
    bodyOverride: body,
    catalogGameId: input.catalogGameId,
    signal: input.signal,
  });
}

async function journalChunksExistForKey(
  supabase: SupabaseClient,
  userId: string,
  gameKey: string,
  platform: string,
): Promise<boolean> {
  if (!gameKey) return false;
  const { count, error } = await supabase
    .from("player_journal_chunks")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("game_key", gameKey)
    .eq("platform", platform || "");
  if (error) return false;
  return (count ?? 0) > 0;
}

export async function journalChunksExist(
  supabase: SupabaseClient,
  userId: string,
  game: string,
  platform: string,
  catalogGameId?: number | null,
): Promise<boolean> {
  const row = await loadPlayerJourney(supabase, userId, game, platform, catalogGameId);
  const gameKey = journeyGameKeyForOps(game, row);
  return journalChunksExistForKey(supabase, userId, gameKey, platform);
}

export async function loadJourneyForSolve(
  supabase: SupabaseClient,
  userId: string,
  game: string,
  platform: string,
  enabled: boolean,
  catalogGameId?: number | null,
) {
  if (!enabled) return { row: null, indexed: false, gameKey: normGameKey(game) };
  const row = await loadPlayerJourney(supabase, userId, game, platform, catalogGameId);
  const gameKey = journeyGameKeyForOps(game, row);
  const indexed = await journalChunksExistForKey(supabase, userId, gameKey, platform);
  return { row, indexed, gameKey };
}
