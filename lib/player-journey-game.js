/**
 * Wipe one game's journal row and chunks. Signed-in only (RLS).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} gameKey normalized via normGameKey
 * @param {string} platform
 * @param {number | null | undefined} [catalogGameId]
 */
export async function forgetGameJourney(supabase, userId, gameKey, platform, catalogGameId) {
  const plat = platform || "";
  const keys = new Set([gameKey]);

  if (catalogGameId != null && Number.isFinite(catalogGameId)) {
    const { data: rows } = await supabase
      .from("player_journey")
      .select("game_key")
      .eq("user_id", userId)
      .eq("catalog_game_id", Math.floor(catalogGameId))
      .eq("platform", plat);
    for (const row of rows ?? []) {
      if (row?.game_key) keys.add(row.game_key);
    }
  }

  for (const key of keys) {
    await supabase
      .from("player_journal_chunks")
      .delete()
      .eq("user_id", userId)
      .eq("game_key", key)
      .eq("platform", plat);
    const { error } = await supabase
      .from("player_journey")
      .delete()
      .eq("user_id", userId)
      .eq("game_key", key)
      .eq("platform", plat);
    if (error) throw error;
  }
}

/**
 * Delete all journals for a user (explicit clear-all action).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function clearAllPlayerJourneys(supabase, userId) {
  await supabase.from("player_journal_chunks").delete().eq("user_id", userId);
  await supabase.from("player_journey").delete().eq("user_id", userId);
}
