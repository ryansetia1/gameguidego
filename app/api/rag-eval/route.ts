import { NextResponse } from "next/server";

import { normalizeGuideUrlList } from "@/lib/guide-urls.js";
import { retrieveFromPreferredGuides, GUIDE_HIT } from "@/lib/guide-rag";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Dev-only calibration probe for the preferred-guide RAG. Returns the raw
 * top-K similarity scores for a single (guideUrls, query) pair so
 * scripts/rag-calibrate.mjs can find the GUIDE_HIT that separates in-guide
 * from off-guide questions. Runs the real ingest + retrieve path (first call
 * per guide indexes it). 404 in production — never expose scores publicly.
 *
 * POST { guideUrls: string[], query: string, game?, platform? }
 */
export async function POST(request: Request) {
  const startedAt = Date.now();
  if (process.env.NODE_ENV === "production" && !process.env.RAG_DEBUG) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: {
    guideUrls?: string[];
    guideUrl?: string;
    query?: string;
    game?: string;
    platform?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawUrls = body.guideUrls ?? (body.guideUrl ? [body.guideUrl] : []);
  const guideUrls = normalizeGuideUrlList(rawUrls);
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!guideUrls.length || !query) {
    return NextResponse.json(
      { error: "Provide guideUrls[] (or guideUrl) and query." },
      { status: 400 },
    );
  }

  const rag = await retrieveFromPreferredGuides({
    guideUrls,
    query,
    game: body.game,
    platform: body.platform,
    requestStartMs: startedAt,
  });

  if (!rag) {
    return NextResponse.json(
      { error: "RAG unavailable (Supabase/Sumopod not configured)." },
      { status: 503 },
    );
  }

  const scores = rag.scores ?? [];
  return NextResponse.json({
    query,
    threshold: GUIDE_HIT,
    hit: rag.skipWebSearch,
    top: scores[0] ?? null,
    scores,
    // Top-1 retrieved chunk text — lets the harness verify retrieval landed on
    // the paragraph you targeted (expectContains), not just cleared the threshold.
    topChunk: rag.sources[0]?.content ?? null,
    // All top-K chunk texts — the harness checks the targeted paragraph across
    // all of them (this is what Gemini actually receives on a hit).
    chunkTexts: rag.chunkTexts ?? [],
    indexedCount: rag.indexedCount,
    totalGuides: rag.totalGuides,
    hubWarning: rag.hubWarning,
  });
}
