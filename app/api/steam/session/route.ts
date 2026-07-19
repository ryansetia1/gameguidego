import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { fetchSteamProfile, steamIdFromMetadata } from "@/lib/steam.js";
import { syntheticEmail, syntheticPassword } from "@/lib/steam-account.js";
import { STEAM_SESSION_COOKIE, verifySteamSession } from "@/lib/steam-session.js";

export const runtime = "nodejs";

type Session = { access_token: string; refresh_token: string } | null;

/**
 * The account that already OWNS this SteamID: a real Google/email account that
 * linked Steam (login_via !== "steam"). Returned so "Sign in with Steam" lands in
 * that account instead of a separate synthetic one — one SteamID, one home.
 * ponytail: scans the first page of users (up to 1000). A prototype won't exceed
 * that; if it ever does, add a steam_links(steam_id -> user_id) table for O(1).
 */
async function findLinkedAccount(admin: SupabaseClient, steamId: string) {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const users = data?.users ?? [];
  return (
    users.find(
      (u) =>
        steamIdFromMetadata(u.user_metadata) === steamId &&
        (u.user_metadata as Record<string, unknown>)?.login_via !== "steam",
    ) ?? null
  );
}

// "Sign in with Steam" bridge. The gg_steam cookie holds a Steam-verified SteamID
// (set by the OpenID callback). We resolve which Supabase account it belongs to
// and return a session for the client to adopt:
//  - a Google/email account that linked this Steam -> sign into THAT account;
//  - otherwise a synthetic account keyed by the SteamID (reserved email
//    namespace, so it can never merge-by-email with a real account).
// Needs the service-role key (email confirmation is on; a synthetic-email signup
// can't self-confirm, and generateLink needs admin).
export async function POST() {
  const jar = await cookies();
  const steamId = verifySteamSession(jar.get(STEAM_SESSION_COOKIE)?.value);
  if (!steamId) {
    return NextResponse.json({ ok: false, error: "no_steam_session" }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 501 });
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Steam persona avatar, refreshed into the account on every login.
  const profile = await fetchSteamProfile(steamId);

  let session: Session = null;

  const linked = await findLinkedAccount(admin, steamId);
  if (linked?.email) {
    // Unify: sign into the account that already owns this Steam. Refresh its
    // Steam avatar first so the picker sees the latest.
    await admin.auth.admin.updateUserById(linked.id, {
      user_metadata: {
        ...(linked.user_metadata ?? {}),
        avatar_steam: profile.avatar || (linked.user_metadata as Record<string, string>)?.avatar_steam || "",
      },
    });
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: linked.email,
    });
    if (linkError || !link.properties?.hashed_token) {
      console.error("Steam unify generateLink failed:", linkError?.message);
      return NextResponse.json({ ok: false, error: "signin_failed" }, { status: 500 });
    }
    const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyError || !verified.session) {
      console.error("Steam unify verifyOtp failed:", verifyError?.message);
      return NextResponse.json({ ok: false, error: "signin_failed" }, { status: 500 });
    }
    session = verified.session;
  } else {
    // Synthetic Steam-login account: create on first login, reuse after.
    const email = syntheticEmail(steamId);
    const password = syntheticPassword(steamId);
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        steam_id: steamId,
        display_name: profile.name,
        avatar_steam: profile.avatar,
        avatar_pref: "steam",
        login_via: "steam",
      },
      app_metadata: { provider: "steam", providers: ["steam"] },
    });
    if (createError && !/registered|already/i.test(createError.message)) {
      console.error("Steam bridge createUser failed:", createError.message);
      return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
    }
    const { data: signedIn, error: signInError } =
      await anon.auth.signInWithPassword({ email, password });
    if (signInError || !signedIn.session) {
      console.error("Steam bridge sign-in failed:", signInError?.message);
      return NextResponse.json({ ok: false, error: "signin_failed" }, { status: 500 });
    }
    // Refresh the Steam avatar on returning logins (createUser only set it once).
    await admin.auth.admin.updateUserById(signedIn.user.id, {
      user_metadata: {
        ...(signedIn.user.user_metadata ?? {}),
        avatar_steam: profile.avatar,
      },
    });
    session = signedIn.session;
  }

  return NextResponse.json({
    ok: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    steamId,
  });
}
