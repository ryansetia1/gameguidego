import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  fetchOwnedGames,
  fetchSteamReleaseYears,
  steamIdFromMetadata,
} from "@/lib/steam.js";
import { STEAM_SESSION_COOKIE, verifySteamSession } from "@/lib/steam-session.js";

export const runtime = "nodejs";

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export async function GET(request: Request) {
  const token = bearerToken(request);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const steamKey = process.env.STEAM_API_KEY;
  const jar = await cookies();
  const cookieSteamId = verifySteamSession(jar.get(STEAM_SESSION_COOKIE)?.value);

  if (!steamKey) {
    return NextResponse.json({ games: [], connected: false, available: false });
  }

  let accountSteamId: string | null = null;
  let authed = false;
  let supabase: ReturnType<typeof createClient> | null = null;
  
  if (token && url && anonKey) {
    supabase = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user) {
      authed = true;
      accountSteamId = steamIdFromMetadata(data.user.user_metadata);
    }
  }

  // Signed-in requests serve ONLY the account's own linked Steam; a device
  // cookie from another user must never leak someone else's library.
  const steamId = authed ? accountSteamId : cookieSteamId;
  if (!steamId) {
    return NextResponse.json({
      games: [],
      connected: false,
      available: true,
    });
  }

  if (!token) {
    return NextResponse.json({ games: [], connected: Boolean(cookieSteamId), available: true }, { status: 401 });
  }

  try {
    const games = await fetchOwnedGames(steamId, steamKey);
    const allAppIds = games.map((game: { appId: number }) => game.appId);
    
    const years: Record<number, string> = {};
    const missingAppIds: number[] = [];

    // 1. Read from Supabase Cache
    if (supabase) {
      // @ts-expect-error No generated types yet
      const { data: cached, error } = await supabase.rpc("get_and_touch_steam_games", {
        p_app_ids: allAppIds,
      });
      const foundIds = new Set<number>();
      if (!error && Array.isArray(cached)) {
        for (const row of cached as any[]) {
          years[row.app_id] = row.release_year ?? "";
          foundIds.add(row.app_id);
        }
      }
      for (const id of allAppIds) {
        if (!foundIds.has(id)) missingAppIds.push(id);
      }
    } else {
      missingAppIds.push(...allAppIds);
    }

    // 2. Fetch missing release years from Steam
    if (missingAppIds.length > 0) {
      const missingYears = await fetchSteamReleaseYears(missingAppIds, steamKey);
      
      const p_app_ids: number[] = [];
      const p_names: string[] = [];
      const p_platforms: string[] = [];
      const p_release_years: string[] = [];
      const p_cover_urls: string[] = [];

      for (const id of missingAppIds) {
        const year = missingYears[id] ?? "";
        years[id] = year;
        
        if (supabase) {
          p_app_ids.push(id);
          const game = games.find((g: any) => g.appId === id);
          p_names.push(game?.name ?? "Unknown");
          p_platforms.push("Steam");
          p_release_years.push(year);
          p_cover_urls.push(game?.cover ?? "");
        }
      }

      // Upsert missing back to Cache
      if (supabase && p_app_ids.length > 0) {
        const { error } = await supabase.rpc("upsert_steam_games_meta", {
          p_app_ids,
          p_names,
          p_platforms,
          p_release_years,
          p_cover_urls,
        });
        if (error) console.error("Failed to upsert steam games cache:", error);
      }
    }
    const enriched = games.map((game: { appId: number }) => ({
      ...game,
      releaseYear: years[game.appId] ?? "",
    }));
    return NextResponse.json({ games: enriched, connected: true, available: true });
  } catch (caught) {
    console.error("Steam library fetch failed:", caught);
    return NextResponse.json({
      games: [],
      connected: true,
      available: true,
      error: "fetch_failed",
    });
  }
}
