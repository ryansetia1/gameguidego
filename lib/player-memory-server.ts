import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import {
  coercePlayerMemoryTier,
  coercePlayerStyle,
  extractUserMessagesFromChats,
  MEMORY_DRAFT_THRESHOLD,
  MEMORY_FULL_THRESHOLD,
  legacyNormGameKey,
  memoryRefreshCooldownRemainingMs,
  normGameKey,
  playerMemoryEnabledFromMetadata,
  tierFromMessageCount,
  type PlayerMemoryTier,
} from "@/lib/player-memory.js";
import {
  mergeGameRowAfterSummarize,
  mergeStyleAfterSummarize,
  readStyleRecord,
  writeStyleRecord,
} from "@/lib/player-memory-pins.js";
import { summarizePlayerMemory } from "@/lib/player-memory-summarize";
import { getTraceId, logTraceEvent } from "@/lib/trace";

export type PlayerMemoryStateRow = {
  user_id: string;
  message_count: number;
  tier: PlayerMemoryTier;
  style: Record<string, unknown>;
  enabled_at: string;
  last_summarized_at: string | null;
  last_manual_refresh_at: string | null;
  updated_at: string;
};

export type PlayerGameMemoryRow = {
  user_id: string;
  game_key: string;
  platform: string;
  progress: string | null;
  notes: string[];
  updated_at: string;
};

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function createAuthedSupabase(token: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anonKey) return null;
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getAuthedUser(
  supabase: SupabaseClient,
): Promise<{ user: User } | { error: string; status: number }> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { error: "Sign in required.", status: 401 };
  }
  return { user: data.user };
}

export function isPlayerMemoryEnabled(user: User) {
  return playerMemoryEnabledFromMetadata(user.user_metadata);
}

export async function loadPlayerMemoryState(
  supabase: SupabaseClient,
  userId: string,
): Promise<PlayerMemoryStateRow | null> {
  const { data, error } = await supabase
    .from("player_memory_state")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as PlayerMemoryStateRow;
}

export async function loadPlayerGameMemory(
  supabase: SupabaseClient,
  userId: string,
  game: string,
  platform: string,
): Promise<PlayerGameMemoryRow | null> {
  const newKey = normGameKey(game);
  if (!newKey) return null;
  // Dual key during the strengthen transition: a memory row saved under the old
  // (lowercase+collapse only) key still loads until the backfill re-keys it.
  const legacyKey = legacyNormGameKey(game);
  const keys = legacyKey && legacyKey !== newKey ? [newKey, legacyKey] : [newKey];
  const { data, error } = await supabase
    .from("player_game_memory")
    .select("*")
    .eq("user_id", userId)
    .in("game_key", keys)
    .eq("platform", platform || "");
  if (error || !data?.length) return null;
  const row = data.find((r) => r.game_key === newKey) ?? data[0];
  return row as PlayerGameMemoryRow;
}

export async function loadAllPlayerGameMemory(
  supabase: SupabaseClient,
  userId: string,
): Promise<PlayerGameMemoryRow[]> {
  const { data, error } = await supabase
    .from("player_game_memory")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error || !data) return [];
  return data as PlayerGameMemoryRow[];
}

export async function clearPlayerMemoryCards(supabase: SupabaseClient, userId: string) {
  const now = new Date().toISOString();
  await supabase.from("player_game_memory").delete().eq("user_id", userId);
  await supabase
    .from("player_memory_state")
    .update({
      style: {},
      tier: "collecting",
      last_summarized_at: null,
      updated_at: now,
    })
    .eq("user_id", userId);
}

type BumpResult = {
  state: PlayerMemoryStateRow;
  hitDraft: boolean;
  hitFull: boolean;
};

export async function bumpPlayerMemoryCount(
  supabase: SupabaseClient,
  userId: string,
): Promise<BumpResult | null> {
  const state = await loadPlayerMemoryState(supabase, userId);
  if (!state) return null;

  const prev = state.message_count;
  const next = prev + 1;
  const tier = tierFromMessageCount(next);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("player_memory_state")
    .update({
      message_count: next,
      tier,
      updated_at: now,
    })
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) return null;

  return {
    state: data as PlayerMemoryStateRow,
    hitDraft: prev < MEMORY_DRAFT_THRESHOLD && next >= MEMORY_DRAFT_THRESHOLD,
    hitFull: prev < MEMORY_FULL_THRESHOLD && next >= MEMORY_FULL_THRESHOLD,
  };
}

export async function refreshPlayerMemory(
  supabase: SupabaseClient,
  userId: string,
  options: { manual?: boolean; force?: boolean; trigger?: string } = {},
): Promise<
  | { ok: true; skipped?: string }
  | { ok: false; error: string; status?: number }
> {
  const startedAt = Date.now();
  const trigger = options.trigger ?? (options.manual ? "manual" : "cron");

  await logTraceEvent("memory_refresh_start", "Player memory refresh started", undefined, {
    userId,
    manual: options.manual ?? false,
    force: options.force ?? false,
    trigger,
  });

  const state = await loadPlayerMemoryState(supabase, userId);
  if (!state) {
    await logTraceEvent("memory_refresh_error", "Memory is not enabled", Date.now() - startedAt, {
      userId,
      reason: "not_enabled",
    });
    return { ok: false, error: "Memory is not enabled.", status: 400 };
  }
  if (state.message_count < MEMORY_DRAFT_THRESHOLD) {
    await logTraceEvent("memory_refresh_skipped", "Not enough questions yet", Date.now() - startedAt, {
      userId,
      reason: "below_threshold",
      messageCount: state.message_count,
    });
    return { ok: false, error: "Needs more questions first.", status: 400 };
  }

  if (options.manual && !options.force) {
    const remaining = memoryRefreshCooldownRemainingMs(state.last_manual_refresh_at);
    if (remaining > 0) {
      await logTraceEvent("memory_refresh_skipped", "Manual refresh on cooldown", Date.now() - startedAt, {
        userId,
        reason: "cooldown",
        remainingMs: remaining,
      });
      return {
        ok: false,
        error: `Try again in ${Math.ceil(remaining / 60_000)} min.`,
        status: 429,
      };
    }
  }

  const since = state.last_summarized_at ?? state.enabled_at;
  const { data: chats, error: chatsError } = await supabase
    .from("chats")
    .select("game, platform, messages, updated_at")
    .eq("user_id", userId)
    .gte("updated_at", since)
    .order("updated_at", { ascending: true });

  if (chatsError) {
    await logTraceEvent("memory_refresh_error", "Could not load chats", Date.now() - startedAt, {
      userId,
      reason: "chats_load_failed",
    });
    return { ok: false, error: "Could not load chats." };
  }

  const delta = extractUserMessagesFromChats(chats ?? [], since);
  let messages = delta;
  if (!messages.length && !state.last_summarized_at) {
    const { data: allChats } = await supabase
      .from("chats")
      .select("game, platform, messages, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: true });
    messages = extractUserMessagesFromChats(allChats ?? [], state.enabled_at);
  }

  await logTraceEvent(
    "memory_load_chats",
    `Loaded ${chats?.length ?? 0} chats, ${messages.length} messages to summarize`,
    Date.now() - startedAt,
    {
      userId,
      chatCount: chats?.length ?? 0,
      deltaMessageCount: messages.length,
      since,
      tier: state.tier,
      messageCount: state.message_count,
    },
  );

  if (!messages.length && state.last_summarized_at) {
    await logTraceEvent("memory_refresh_skipped", "No new messages since last summarize", Date.now() - startedAt, {
      userId,
      reason: "no_new_messages",
    });
    return { ok: true, skipped: "no_new_messages" };
  }

  const { style: existingStyle, userPins } = readStyleRecord(state.style);
  const existingGames = await loadAllPlayerGameMemory(supabase, userId);

  await logTraceEvent("memory_summarize_start", "Summarizing player memory", undefined, {
    userId,
    deltaMessageCount: messages.length,
    existingGameCount: existingGames.length,
    existingStyleNoteCount: (existingStyle.notes ?? []).length,
  });

  const summary = await summarizePlayerMemory({
    userId,
    traceId: getTraceId(),
    existingStyle,
    existingGames,
    deltaMessages: messages,
  });

  if (!summary) {
    await logTraceEvent("memory_refresh_error", "Summarize returned no result", Date.now() - startedAt, {
      userId,
      reason: "summarize_failed",
    });
    return { ok: false, error: "Could not update memory." };
  }

  const mergedStyle = mergeStyleAfterSummarize(existingStyle, userPins, summary.style);

  const now = new Date().toISOString();
  const tier = coercePlayerMemoryTier(state.tier, state.message_count);

  const { error: stateError } = await supabase
    .from("player_memory_state")
    .update({
      style: writeStyleRecord(mergedStyle, userPins),
      tier,
      last_summarized_at: now,
      ...(options.manual ? { last_manual_refresh_at: now } : {}),
      updated_at: now,
    })
    .eq("user_id", userId);

  if (stateError) {
    await logTraceEvent("memory_refresh_error", "Could not save memory state", Date.now() - startedAt, {
      userId,
      reason: "state_save_failed",
    });
    return { ok: false, error: "Could not save memory." };
  }

  let gamesUpdated = 0;
  for (const game of summary.games) {
    const gameKey = normGameKey(game.gameKey);
    if (!gameKey) continue;
    const platform = game.platform?.slice(0, 40) ?? "";
    const existingRow = existingGames.find(
      (row) => row.game_key === gameKey && row.platform === platform,
    );
    const mergedRow = existingRow
      ? mergeGameRowAfterSummarize(existingRow, game, userPins)
      : {
          game_key: gameKey,
          platform,
          progress: game.progress?.slice(0, 200) ?? null,
          notes: game.notes ?? [],
        };
    await supabase.from("player_game_memory").upsert({
      user_id: userId,
      game_key: mergedRow.game_key,
      platform: mergedRow.platform,
      progress: mergedRow.progress,
      notes: mergedRow.notes,
      updated_at: now,
    });
    gamesUpdated += 1;
  }

  const styleNoteCount = (mergedStyle.notes ?? []).length;
  await logTraceEvent("memory_save_complete", "Saved player memory cards", undefined, {
    userId,
    gamesUpdated,
    styleNoteCount,
    tier,
  });

  await logTraceEvent("memory_refresh_complete", "Player memory refresh finished", Date.now() - startedAt, {
    userId,
    trigger,
    gamesUpdated,
    styleNoteCount,
    tier,
    deltaMessageCount: messages.length,
  });

  return { ok: true };
}

export function memoryForPrompt(
  state: PlayerMemoryStateRow | null,
  gameRow: PlayerGameMemoryRow | null,
) {
  if (!state || state.tier === "collecting") return null;
  return {
    tier: coercePlayerMemoryTier(state.tier, state.message_count),
    style: coercePlayerStyle(state.style),
    gameMemory: gameRow
      ? {
          progress: gameRow.progress ?? undefined,
          notes: gameRow.notes ?? [],
        }
      : null,
  };
}

export async function loadMemoryForSolve(
  supabase: SupabaseClient,
  userId: string,
  game: string,
  platform: string,
) {
  const state = await loadPlayerMemoryState(supabase, userId);
  if (!state || state.tier === "collecting") return null;
  const gameRow = await loadPlayerGameMemory(supabase, userId, game, platform);
  return memoryForPrompt(state, gameRow);
}
