import { NextResponse } from "next/server";

import { fetchSteamReleaseYear } from "@/lib/steam.js";

export const runtime = "nodejs";

/** Release year for a Steam app (GetItems include_release — not in GetOwnedGames). */
export async function GET(request: Request) {
  const appId = Number(new URL(request.url).searchParams.get("appId"));
  if (!Number.isFinite(appId) || appId <= 0) {
    return NextResponse.json({ year: "" });
  }
  const year = await fetchSteamReleaseYear(appId);
  return NextResponse.json({ year });
}
