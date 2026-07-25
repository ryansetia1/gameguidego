import { gameMemoryPinKey, readStyleRecord, writeStyleRecord } from "./player-memory-pins.js";

/**
 * Delete one per-game memory row and drop its style pins so a re-added game
 * starts clean. Signed-in only (RLS scopes every write to the caller).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} gameKey  already normalized via normGameKey
 * @param {string} platform
 */
export async function forgetGameMemory(supabase, userId, gameKey, platform) {
  const { error } = await supabase
    .from("player_game_memory")
    .delete()
    .eq("user_id", userId)
    .eq("game_key", gameKey)
    .eq("platform", platform || "");
  if (error) throw error;

  // ponytail: read-modify-write of the style JSON. Single per-user action, so the
  // read/write race is not worth a lock; add one if a bulk-forget ever lands.
  const { data } = await supabase
    .from("player_memory_state")
    .select("style")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return;
  const { style, userPins } = readStyleRecord(data.style);
  const key = gameMemoryPinKey(gameKey, platform);
  if (!userPins.games?.[key]) return;
  const games = { ...userPins.games };
  delete games[key];
  await supabase
    .from("player_memory_state")
    .update({
      style: writeStyleRecord(style, { ...userPins, games }),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}
