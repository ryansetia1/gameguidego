import { NextResponse } from "next/server";

import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
  loadAllPlayerGameMemory,
  loadPlayerMemoryState,
  refreshPlayerMemory,
  setPlayerMemoryEnabled,
} from "@/lib/player-memory-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const supabase = createAuthedSupabase(token);
  if (!supabase) {
    return NextResponse.json({ error: "Accounts are not configured." }, { status: 503 });
  }

  const auth = await getAuthedUser(supabase);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const state = await loadPlayerMemoryState(supabase, auth.user.id);
  const games = state ? await loadAllPlayerGameMemory(supabase, auth.user.id) : [];

  return NextResponse.json({
    enabled: Boolean(state),
    state,
    games,
  });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Could not read the request." }, { status: 400 });
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const token = bearerToken(request);
  const supabase = createAuthedSupabase(token);
  if (!supabase) {
    return NextResponse.json({ error: "Accounts are not configured." }, { status: 503 });
  }

  const auth = await getAuthedUser(supabase);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  if (typeof record.enabled === "boolean") {
    try {
      await setPlayerMemoryEnabled(supabase, auth.user, record.enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update setting.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
    const state = await loadPlayerMemoryState(supabase, auth.user.id);
    return NextResponse.json({ enabled: record.enabled, state });
  }

  return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
}
