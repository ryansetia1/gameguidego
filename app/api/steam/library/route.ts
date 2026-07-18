import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { fetchOwnedGames, steamIdFromMetadata } from "@/lib/steam.js";
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
  if (token && url && anonKey) {
    const supabase = createClient(url, anonKey, {
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
    return NextResponse.json({ games, connected: true, available: true });
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
