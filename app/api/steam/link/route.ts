import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getAuthOrigin } from "@/lib/origin";
import { PENDING_STEAM_COOKIE } from "@/lib/steam.js";

export const runtime = "nodejs";

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export async function POST(request: Request) {
  const origin = getAuthOrigin(request);
  const secure = origin.startsWith("https");

  const jar = await cookies();
  const steamId = jar.get(PENDING_STEAM_COOKIE)?.value ?? "";
  if (!/^\d{5,}$/.test(steamId)) {
    return NextResponse.json({ ok: false, error: "no_pending" }, { status: 400 });
  }

  const token = bearerToken(request);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anonKey) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data.user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { error: linkError } = await supabase.auth.updateUser({
    data: { steam_id: steamId },
  });
  if (linkError) {
    console.error("Steam link failed:", linkError.message);
    return NextResponse.json({ ok: false, error: "link_failed" }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, steamId });
  response.cookies.set(PENDING_STEAM_COOKIE, "", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
