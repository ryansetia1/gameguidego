import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { steamIdFromMetadata } from "@/lib/steam.js";
import { STEAM_SESSION_COOKIE, verifySteamSession } from "@/lib/steam-session.js";

export const runtime = "nodejs";

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export async function GET(request: Request) {
  const jar = await cookies();
  const cookieSteamId = verifySteamSession(jar.get(STEAM_SESSION_COOKIE)?.value);

  const token = bearerToken(request);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let accountSteamId: string | null = null;
  let authed = false;
  if (token && url && anonKey) {
    const supabase = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      authed = true;
      accountSteamId = steamIdFromMetadata(data.user.user_metadata);
    }
  }

  // Authenticated context trusts ONLY the account's linked Steam — never a
  // device cookie left by another user. The cookie is for the token-less
  // transient right after the OpenID return, before linking persists.
  const steamId = authed ? accountSteamId : cookieSteamId;
  return NextResponse.json({
    steamId,
    connected: Boolean(steamId),
    linkedToAccount: Boolean(accountSteamId),
  });
}
