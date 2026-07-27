import { NextResponse } from "next/server";

import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";
import { playerJourneyEnabledFromMetadata } from "@/lib/player-journey.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const supabase = createAuthedSupabase(token);
  if (!supabase) {
    return NextResponse.json({ error: "Accounts are not configured." }, { status: 503 });
  }

  const auth = await getAuthedUser(supabase);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (!playerJourneyEnabledFromMetadata(auth.user.user_metadata)) {
    return NextResponse.json({ journeys: [] });
  }

  const { data, error } = await supabase
    .from("player_journey")
    .select(
      "game_key, platform, catalog_game_id, body_chars, last_updated_at, updating_at, last_toast_summary",
    )
    .eq("user_id", auth.user.id)
    .order("last_updated_at", { ascending: false, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: "Could not load journals." }, { status: 500 });
  }

  return NextResponse.json({
    journeys: (data ?? []).map((row) => ({
      gameKey: row.game_key,
      platform: row.platform ?? "",
      catalogGameId: row.catalog_game_id ?? null,
      bodyChars: row.body_chars ?? 0,
      lastUpdatedAt: row.last_updated_at ?? null,
      updatingAt: row.updating_at ?? null,
      lastToastSummary: row.last_toast_summary ?? "",
    })),
  });
}
