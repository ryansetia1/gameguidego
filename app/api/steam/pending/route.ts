import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { PENDING_STEAM_COOKIE } from "@/lib/steam.js";

export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const steamId = cookieStore.get(PENDING_STEAM_COOKIE)?.value ?? "";
  if (!/^\d{5,}$/.test(steamId)) {
    return NextResponse.json({ steamId: null });
  }
  return NextResponse.json({ steamId });
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PENDING_STEAM_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
