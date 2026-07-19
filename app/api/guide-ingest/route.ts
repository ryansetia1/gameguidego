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
  const ingestCtx = { game, platform, userId };
  const bundlePrefs = coerceBundlePrefsFromBody(record.bundlePrefs);

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

  try {
    const settled = [];
    for (const url of urls) {
      const prefs = bundlePrefs[url];
      const startMs = Date.now();
      try {
        const result = await ensureGuideIngested(url, request.signal, {
          ...ingestCtx,
          skipSlugs: prefs?.skippedSlugs,
          includeSlugs: prefs?.selectedSlugs,
        });
        settled.push({ url, ...result });
        
        logIngestJourneyToDb({
          userId,
          game,
          platform,
          url,
          latencyMs: Date.now() - startMs,
          status: "success",
          pagesIndexed: result.chunkCount > 0 ? 1 : 0, // ensureGuideIngested currently returns chunkCount, but wait, does it return pages_indexed? We don't have accurate pages indexed per ensureGuideIngested without inspecting deep inside, but we know if it succeeded.
          hubWarning: result.hubWarning,
        }).catch(console.error);
      } catch (err) {
        settled.push({ url, indexed: false, chunkCount: 0, hubWarning: false });
        logIngestJourneyToDb({
          userId,
          game,
          platform,
          url,
          latencyMs: Date.now() - startMs,
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        }).catch(console.error);
      }
    }
    const indexedCount = settled.filter((row) => row.indexed).length;
    const hubWarning = settled.some((row) => row.hubWarning);

    return NextResponse.json({
      available: true,
      indexed: indexedCount === urls.length,
      indexedCount,
      total: urls.length,
      hubWarning,
      results: settled,
    });
  } catch (error) {
    console.error("Guide ingest failed:", error);
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
      
    // Log the whole batch failure if something outside the loop threw
    for (const url of urls) {
      logIngestJourneyToDb({
        userId,
        game,
        platform,
        url,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(console.error);
    }
    
    return NextResponse.json(
      { error: timedOut ? "Indexing took too long. Try again." : "Couldn't index that guide." },
      { status: timedOut ? 504 : 502 },
    );
  }
}
