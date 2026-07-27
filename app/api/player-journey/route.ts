import { NextResponse } from "next/server";

import { journalChunksExist } from "@/lib/player-journey-rag";
import {
  loadPlayerJourney,
  pendingManualJournalUpdate,
  saveManualJournalEdit,
} from "@/lib/player-journey-server";
import { cleanJourneyText } from "@/lib/player-journey-client.js";
import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";
import { normGameKey } from "@/lib/player-memory.js";
import { JOURNAL_BODY_MAX, playerJourneyEnabledFromMetadata } from "@/lib/player-journey.js";
import { runWithTrace } from "@/lib/trace";

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

  const journeyEnabled = playerJourneyEnabledFromMetadata(auth.user.user_metadata);

  const url = new URL(request.url);
  const game = cleanJourneyText(url.searchParams.get("game"), 120);
  const platform = cleanJourneyText(url.searchParams.get("platform"), 40);
  const catalogParam = url.searchParams.get("catalogGameId");
  const catalogGameId =
    catalogParam && Number.isFinite(Number(catalogParam))
      ? Math.floor(Number(catalogParam))
      : null;
  if (!game || !normGameKey(game)) {
    return NextResponse.json({ error: "Game is required." }, { status: 400 });
  }

  const row = await loadPlayerJourney(supabase, auth.user.id, game, platform, catalogGameId);
  const indexed = await journalChunksExist(
    supabase,
    auth.user.id,
    game,
    platform,
    catalogGameId,
  );
  const pending = await pendingManualJournalUpdate(
    supabase,
    auth.user.id,
    game,
    platform,
    row?.last_chat_message_at ?? null,
  );

  return NextResponse.json({
    journeyEnabled,
    body: row?.body ?? "",
    lastUpdatedAt: row?.last_updated_at ?? null,
    lastChatMessageAt: row?.last_chat_message_at ?? null,
    updatingAt: row?.updating_at ?? null,
    lastToastSummary: row?.last_toast_summary ?? "",
    indexed,
    bodyChars: row?.body_chars ?? 0,
    canManualUpdate: pending.canManualUpdate,
  });
}

export async function PATCH(request: Request) {
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
    return NextResponse.json({ error: "Progress tracking is off." }, { status: 403 });
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
  const journalBody =
    typeof record.body === "string" ? record.body.slice(0, JOURNAL_BODY_MAX) : "";
  const catalogGameId =
    typeof record.catalogGameId === "number" && Number.isFinite(record.catalogGameId)
      ? Math.floor(record.catalogGameId)
      : null;

  if (!game || !normGameKey(game)) {
    return NextResponse.json({ error: "Game is required." }, { status: 400 });
  }

  const result = await runWithTrace(request.headers.get("X-Trace-Id") || crypto.randomUUID(), () =>
    saveManualJournalEdit({
      supabase,
      userId: auth.user.id,
      game,
      platform,
      body: journalBody,
      catalogGameId,
    }),
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    bodyChars: result.bodyChars,
    chunkCount: result.chunkCount,
    summary: result.toastSummary,
    skipped: result.skipped ?? null,
  });
}
