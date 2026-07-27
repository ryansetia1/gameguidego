import { NextResponse } from "next/server";

import { runJournalUpdate } from "@/lib/player-journey-server";
import { playerJourneyEnabledFromMetadata } from "@/lib/player-journey.js";
import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";
import { normGameKey } from "@/lib/player-memory.js";

export const runtime = "nodejs";

import { cleanJourneyText } from "@/lib/player-journey-client.js";

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

  if (!playerJourneyEnabledFromMetadata(auth.user.user_metadata)) {
    return NextResponse.json({ error: "Track my progress is off." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Could not read the request." }, { status: 400 });
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const game = cleanJourneyText(record.game, 120);
  const platform = cleanJourneyText(record.platform, 40);
  const catalogGameId =
    typeof record.catalogGameId === "number" && Number.isFinite(record.catalogGameId)
      ? Math.floor(record.catalogGameId)
      : null;

  if (!game || !normGameKey(game)) {
    return NextResponse.json({ error: "Game is required." }, { status: 400 });
  }

  const result = await runJournalUpdate({
    supabase,
    userId: auth.user.id,
    game,
    platform,
    trigger: "manual",
    catalogGameId,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  if (result.skipped) {
    return NextResponse.json({
      ok: true,
      skipped: result.skipped,
      bodyChars: result.bodyChars,
      chunkCount: result.chunkCount,
    });
  }

  return NextResponse.json({
    ok: true,
    bodyChars: result.bodyChars,
    chunkCount: result.chunkCount,
    summary: result.toastSummary,
  });
}
