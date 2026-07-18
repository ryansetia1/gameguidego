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
  const response = NextResponse.redirect(buildSteamLoginUrl(origin, state));
  response.cookies.set(OPENID_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: OPENID_STATE_MAX_AGE,
  });
  return response;
}
