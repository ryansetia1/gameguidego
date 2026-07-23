import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import {
  coercePlayerMemoryTier,
  coercePlayerStyle,
  extractUserMessagesFromChats,
  MEMORY_DRAFT_THRESHOLD,
  MEMORY_FULL_THRESHOLD,
  memoryRefreshCooldownRemainingMs,
  normGameKey,
  playerMemoryEnabledFromMetadata,
  tierFromMessageCount,
  type PlayerMemoryTier,
} from "@/lib/player-memory.js";
import { summarizePlayerMemory } from "@/lib/player-memory-summarize";

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
  const gameKey = normGameKey(game);
  if (!gameKey) return null;
  const { data, error } = await supabase
    .from("player_game_memory")
    .select("*")
    .eq("user_id", userId)
    .eq("game_key", gameKey)
    .eq("platform", platform || "")
    .maybeSingle();
  if (error || !data) return null;
  return data as PlayerGameMemoryRow;
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

export async function setPlayerMemoryEnabled(
  supabase: SupabaseClient,
  user: User,
  enabled: boolean,
) {
  if (enabled) {
    const now = new Date().toISOString();
    const { error: metaError } = await supabase.auth.updateUser({
      data: { player_memory_enabled: true },
    });
    if (metaError) throw metaError;

    const { error: stateError } = await supabase.from("player_memory_state").upsert({
      user_id: user.id,
      message_count: 0,
      tier: "collecting",
      style: {},
      enabled_at: now,
      last_summarized_at: null,
      last_manual_refresh_at: null,
      updated_at: now,
    });
    if (stateError) throw stateError;
    return;
  }

  const { error: metaError } = await supabase.auth.updateUser({
    data: { player_memory_enabled: false },
  });
  if (metaError) throw metaError;

  await supabase.from("player_game_memory").delete().eq("user_id", user.id);
  await supabase.from("player_memory_state").delete().eq("user_id", user.id);
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
  options: { manual?: boolean; force?: boolean } = {},
): Promise<
  | { ok: true; skipped?: string }
  | { ok: false; error: string; status?: number }
> {
  const state = await loadPlayerMemoryState(supabase, userId);
  if (!state) return { ok: false, error: "Memory is not enabled.", status: 400 };
  if (state.message_count < MEMORY_DRAFT_THRESHOLD) {
    return { ok: false, error: "Needs more questions first.", status: 400 };
  }

  if (options.manual && !options.force) {
    const remaining = memoryRefreshCooldownRemainingMs(state.last_manual_refresh_at);
    if (remaining > 0) {
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
  if (!messages.length && state.last_summarized_at) {
    return { ok: true, skipped: "no_new_messages" };
  }

  const existingGames = await loadAllPlayerGameMemory(supabase, userId);
  const summary = await summarizePlayerMemory({
    userId,
    existingStyle: coercePlayerStyle(state.style),
    existingGames,
    deltaMessages: messages,
  });

  if (!summary) {
    return { ok: false, error: "Could not update memory." };
  }

  const now = new Date().toISOString();
  const tier = coercePlayerMemoryTier(state.tier, state.message_count);

  const { error: stateError } = await supabase
    .from("player_memory_state")
    .update({
      style: summary.style,
      tier,
      last_summarized_at: now,
      ...(options.manual ? { last_manual_refresh_at: now } : {}),
      updated_at: now,
    })
    .eq("user_id", userId);

  if (stateError) {
    return { ok: false, error: "Could not save memory." };
  }

  for (const game of summary.games) {
    const gameKey = normGameKey(game.gameKey);
    if (!gameKey) continue;
    await supabase.from("player_game_memory").upsert({
      user_id: userId,
      game_key: gameKey,
      platform: game.platform?.slice(0, 40) ?? "",
      progress: game.progress?.slice(0, 200) ?? null,
      notes: game.notes ?? [],
      updated_at: now,
    });
  }

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
