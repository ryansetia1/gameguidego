import { NextResponse } from "next/server";

import { getAuthOrigin } from "@/lib/origin";
import {
  buildSteamLoginUrl,
  newOpenIdState,
  OPENID_STATE_COOKIE,
  OPENID_STATE_MAX_AGE,
} from "@/lib/steam.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const origin = getAuthOrigin(request);
  const secure = origin.startsWith("https");
  const state = newOpenIdState();
  // "signin" => bridge to a Supabase account (logged-out user); "link" (default)
  // => attach Steam to the signed-in account (sidebar "Connect Steam").
  const params = new URL(request.url).searchParams;
  const intent = params.get("intent") === "signin" ? "signin" : "link";
  const popup = params.get("popup") === "1";
  const apkAuth = params.get("apk_auth") === "1";
  const response = NextResponse.redirect(buildSteamLoginUrl(origin, state, intent, popup));
  response.cookies.set(OPENID_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: OPENID_STATE_MAX_AGE,
  });
  if (apkAuth) {
    response.cookies.set("gg_apk_auth", "1", {
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 300,
    });
  }
  return response;
}
