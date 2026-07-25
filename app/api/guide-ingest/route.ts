import { NextResponse } from "next/server";

import {
  coerceGuideUrlsFromBody,
  cleanGuideUrl,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import { coerceBundlePrefsFromBody } from "@/lib/bundle-prefs.js";
import {
  ensureGuideIngested,
  isGuideIndexed,
  isGuideRagAvailable,
} from "@/lib/guide-ingest";
import { logIngestJourneyToDb } from "@/lib/solve-log";
import { runWithTrace, logTraceEvent } from "@/lib/trace";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const urls = normalizeGuideUrlList(
    [
      ...searchParams.getAll("url"),
      ...(searchParams.get("urls")
        ? searchParams.get("urls")!.split(",")
        : []),
    ].flatMap((value) => {
      const url = cleanGuideUrl(value);
      return url ? [url] : [];
    }),
  );

  if (!urls.length) {
    return NextResponse.json({ error: "Missing guide URL." }, { status: 400 });
  }

  if (!isGuideRagAvailable()) {
    return NextResponse.json({ available: false, indexed: false, results: [] });
  }

  const results = await Promise.all(
    urls.map(async (url) => ({
      url,
      indexed: await isGuideIndexed(url),
    })),
  );
  const indexedCount = results.filter((row) => row.indexed).length;

  return NextResponse.json({
    available: true,
    indexed: indexedCount === urls.length,
    indexedCount,
    total: urls.length,
    results,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Could not read the request." }, { status: 400 });
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const urls = coerceGuideUrlsFromBody(record);
  const game = typeof record.game === "string" ? record.game.slice(0, 120) : undefined;
  const platform = typeof record.platform === "string" ? record.platform.slice(0, 80) : undefined;
  const userId =
    typeof record.userId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.userId)
      ? record.userId
      : null;
  const playerName =
    typeof record.playerName === "string" ? record.playerName.replace(/\s+/g, " ").trim().slice(0, 32) : "";
  const ingestCtx = { game, platform, userId, playerName: playerName || undefined };
  const bundlePrefs = coerceBundlePrefsFromBody(record.bundlePrefs);
  const retryFailed = record.retryFailed === true;

  if (!urls.length) {
    return NextResponse.json({ error: "Missing guide URL." }, { status: 400 });
  }

  if (!isGuideRagAvailable()) {
    return NextResponse.json({
      available: false,
      indexed: false,
      indexedCount: 0,
      total: urls.length,
      results: [],
    });
  }

  const traceId = request.headers.get("X-Trace-Id") || crypto.randomUUID();

  return runWithTrace(traceId, async () => {
    await logTraceEvent("ingest_start", `Starting guide ingest for ${urls.length} URLs`, undefined, {
      game,
      platform,
      userId,
      playerName: playerName || undefined,
    });
    const results: Array<Record<string, unknown>> = [];
    let anyHubWarning = false;
    let anyError = false;

    for (const url of urls) {
      const start = Date.now();
      const prefs = bundlePrefs[url];
      try {
        const result = await ensureGuideIngested(url, request.signal, {
          ...ingestCtx,
          skipSlugs: prefs?.skippedSlugs,
          includeSlugs: prefs?.selectedSlugs,
          retryFailed,
        });
        results.push({ ...result, url });
        if (result.hubWarning) anyHubWarning = true;

        const latencyMs = Date.now() - start;
        if (result.indexed) {
          void logIngestJourneyToDb({
            userId: ingestCtx.userId,
            playerName: ingestCtx.playerName,
            traceId,
            game: ingestCtx.game,
            platform: ingestCtx.platform,
            url,
            latencyMs,
            status: "success",
            pagesIndexed: result.pagesIndexed ?? (result.chunkCount > 0 ? 1 : 0),
            hubWarning: result.hubWarning,
          });
          await logTraceEvent("ingest_url_complete", `Ingested URL: ${url}`, latencyMs, { result });
        } else {
          const errorMessage = result.isBlocked
            ? "GameFAQs blocked: could not extract guide content"
            : result.hubWarning
              ? "Guide looks like a hub or extract was too short"
              : "Guide was not indexed";
          void logIngestJourneyToDb({
            userId: ingestCtx.userId,
            playerName: ingestCtx.playerName,
            traceId,
            game: ingestCtx.game,
            platform: ingestCtx.platform,
            url,
            latencyMs,
            status: "error",
            pagesIndexed: 0,
            hubWarning: result.hubWarning,
            errorMessage,
          });
          await logTraceEvent(
            result.isBlocked ? "ingest_url_blocked" : "ingest_url_failed",
            result.isBlocked
              ? `Blocked guide ingest for ${url}`
              : `Guide ingest did not index ${url}`,
            latencyMs,
            { result, error: errorMessage },
          );
        }
      } catch (err: unknown) {
        anyError = true;
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ url, indexed: false, error: msg });
        void logIngestJourneyToDb({
          userId: ingestCtx.userId,
          playerName: ingestCtx.playerName,
          traceId,
          game: ingestCtx.game,
          platform: ingestCtx.platform,
          url,
          latencyMs: Date.now() - start,
          status: "error",
          errorMessage: msg,
        });
        await logTraceEvent("ingest_url_error", `Error ingesting URL: ${url} - ${msg}`, Date.now() - start, { error: msg });
      }
    }

    if (anyError) {
      return NextResponse.json(
        { error: "One or more guides failed to index.", results },
        { status: 500 },
      );
    }

    const indexedCount = results.filter((row) => row.indexed === true).length;

    return NextResponse.json({
      available: true,
      indexed: indexedCount === urls.length,
      indexedCount,
      total: urls.length,
      hubWarning: anyHubWarning,
      results,
    });
  });
}
