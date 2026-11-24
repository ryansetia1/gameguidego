import { NextResponse } from "next/server";

import { getCachedVGMapsDirectory } from "@/lib/vgmaps-cache";
import { findVGMapsGameMatches } from "@/lib/vgmaps-parser.js";

export const runtime = "nodejs";

const MAX_LEN = 200;

// VGMaps games matching the active game (+ platform bonus), from the cached Atlas index.
// No login: maps work for signed-out players too.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const game = (searchParams.get("game") ?? "").trim().slice(0, MAX_LEN);
  const platform = (searchParams.get("platform") ?? "").trim().slice(0, MAX_LEN);
  if (!game) return NextResponse.json({ games: [], available: true });

  try {
    const entries = await getCachedVGMapsDirectory();
    const games = findVGMapsGameMatches(game, entries, { platform, limit: 15 });
    return NextResponse.json(
      { games, available: true },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    console.error("VGMaps search failed:", err);
    return NextResponse.json({ games: [], available: false });
  }
}
