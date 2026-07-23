import { NextResponse } from "next/server";

import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
  loadPlayerMemoryState,
  refreshPlayerMemory,
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

  const result = await refreshPlayerMemory(supabase, auth.user.id, { manual: true });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });
  }

  const state = await loadPlayerMemoryState(supabase, auth.user.id);
  return NextResponse.json({ ok: true, skipped: result.skipped ?? null, state });
}
