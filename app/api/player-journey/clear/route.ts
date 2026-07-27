import { NextResponse } from "next/server";

import { clearAllPlayerJourneys } from "@/lib/player-journey-game.js";
import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = bearerToken(request);
  const supabase = createAuthedSupabase(token);
  if (!supabase) {
    return NextResponse.json({ error: "Accounts are not configured." }, { status: 503 });
  }

  const auth = await getAuthedUser(supabase);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    await clearAllPlayerJourneys(supabase, auth.user.id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not clear journals." }, { status: 500 });
  }
}
