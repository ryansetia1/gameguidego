import type { SupabaseClient } from "@supabase/supabase-js";

import { embedQuery } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import { JOURNAL_RETRIEVE_K, JOURNAL_SOURCE_URL } from "@/lib/player-journey.js";
import {
  journeyGameKeyForOps,
  journalChunksExist,
  loadPlayerJourney,
} from "@/lib/player-journey-server";
import { logTraceEvent } from "@/lib/trace";
import type { SearchResult } from "@/lib/tavily";

type MatchRow = {
  chunk_text: string;
  chunk_index: number;
  similarity: number;
};

export { journalChunksExist };

export async function retrieveFromPlayerJournal(input: {
  supabase: SupabaseClient;
  userId: string;
  game: string;
  platform: string;
  query: string;
  catalogGameId?: number | null;
  signal?: AbortSignal;
}): Promise<SearchResult[]> {
  const row = await loadPlayerJourney(
    input.supabase,
    input.userId,
    input.game,
    input.platform,
    input.catalogGameId,
  );
  const gameKey = journeyGameKeyForOps(input.game, row);
  if (!gameKey || !input.userId) return [];

  const { count, error } = await input.supabase
    .from("player_journal_chunks")
    .select("*", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .eq("game_key", gameKey)
    .eq("platform", input.platform || "");
  const indexed = !error && (count ?? 0) > 0;
  if (!indexed) {
    void logTraceEvent("journal_rag_skipped", "No indexed journal for this game", undefined, {
      game: input.game,
      platform: input.platform,
      userId: input.userId,
    });
    return [];
  }

  const start = Date.now();
  try {
    const embedding = await embedQuery(input.query, input.signal, {
      game: input.game,
      platform: input.platform,
      userId: input.userId,
      purpose: "rag_query",
    });
    if (!embedding) return [];
    const { data, error } = await input.supabase.rpc("match_player_journal_chunks", {
      p_user_id: input.userId,
      p_game_key: gameKey,
      p_platform: input.platform || "",
      p_embedding: toVectorString(embedding),
      p_limit: JOURNAL_RETRIEVE_K,
    });
    if (error) throw error;
    const matches = (data ?? []) as MatchRow[];
    void logTraceEvent(
      "journal_rag_retrieve",
      `Retrieved ${matches.length} journal chunk(s)`,
      Date.now() - start,
      {
        matchCount: matches.length,
        topSimilarity: matches[0]?.similarity ?? 0,
        game: input.game,
        platform: input.platform,
        userId: input.userId,
      },
    );
    if (!matches.length) return [];
    return matches.map((row, index) => ({
      title: `Your progress (section ${index + 1})`,
      url: JOURNAL_SOURCE_URL,
      content: row.chunk_text,
      score: row.similarity,
      preferred: false,
    }));
  } catch (error) {
    console.error("Journal RAG retrieval failed:", error);
    return [];
  }
}
