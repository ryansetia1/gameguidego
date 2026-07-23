import { NextResponse } from "next/server";

import { createServiceSupabase, refreshPlayerMemory } from "@/lib/player-memory-server";
import { MEMORY_DRAFT_THRESHOLD } from "@/lib/player-memory.js";

export const runtime = "nodejs";
export const maxDuration = 300;

function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceSupabase();
  if (!supabase) {
    return NextResponse.json({ error: "Service role not configured." }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("player_memory_state")
    .select("user_id, message_count")
    .gte("message_count", MEMORY_DRAFT_THRESHOLD);

  if (error) {
    return NextResponse.json({ error: "Could not list subscribers." }, { status: 500 });
  }

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of data ?? []) {
    const userId = typeof row.user_id === "string" ? row.user_id : "";
    if (!userId) continue;
    const result = await refreshPlayerMemory(supabase, userId, { manual: false });
    if (!result.ok) {
      failed += 1;
      continue;
    }
    if (result.skipped) skipped += 1;
    else refreshed += 1;
  }

  return NextResponse.json({
    ok: true,
    total: data?.length ?? 0,
    refreshed,
    skipped,
    failed,
  });
}
