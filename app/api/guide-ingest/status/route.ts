import { NextResponse } from "next/server";

import {
  EMBED_MODEL_PREFERENCE,
  ensureSumopodHealth,
  getUsableEmbedModels,
  SUMOPOD_MODEL_TAG,
  syncSumopodHealth,
} from "@/lib/embed";
import { classifyGuideIndexStatus } from "@/lib/guide-embed-state.js";
import {
  getGuideDisplayTitle,
  getGuideEmbedSummary,
  isDualVectorRpcReady,
  isGuideRagAvailable,
  isGuideRefreshing,
} from "@/lib/guide-ingest";
import { cleanGuideUrl, normalizeGuideUrlList } from "@/lib/guide-urls.js";
import { getServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

/**
 * Lightweight status check — does NOT trigger ingest.
 * GET /api/guide-ingest/status?url=...&url=...
 *     or ?urls=url1,url2
 */
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

  const available = isGuideRagAvailable();
  if (!available) {
    return NextResponse.json({
      available: false,
      results: urls.map((url) => ({
        url,
        indexed: false,
        status: "unavailable",
        canRefresh: false,
        autoRefreshable: false,
        chunkCount: 0,
      })),
    });
  }

  const entries = await Promise.all(
    urls.map(async (url) => {
      const summary = await getGuideEmbedSummary(url);
      const title = summary.indexed ? await getGuideDisplayTitle(url) : null;
      return { url, summary, title };
    }),
  );

  const hasAnyNext = entries.some((entry) => entry.summary.indexed && Boolean(entry.summary.embedModelNext));
  const dualRpcReady = hasAnyNext ? await isDualVectorRpcReady(getServerClient()) : false;
  const needsSumopod = entries.some(
    (entry) =>
      entry.summary.indexed &&
      (!entry.summary.embedModelNext || !dualRpcReady) &&
      (entry.summary.embedModel || SUMOPOD_MODEL_TAG) === SUMOPOD_MODEL_TAG,
  );

  if (needsSumopod) {
    await ensureSumopodHealth();
  } else {
    await syncSumopodHealth();
  }

  const usableModels = getUsableEmbedModels();
  const results = entries.map(({ url, summary, title }) => {
    const classified = classifyGuideIndexStatus({
      indexed: summary.indexed,
      chunkCount: summary.chunkCount,
      embedModel: summary.embedModel,
      embedModelNext: summary.embedModelNext,
      usableModels,
      preferredOrder: EMBED_MODEL_PREFERENCE,
      isRefreshing: isGuideRefreshing(url),
      dualRpcReady,
    });
    return {
      url,
      indexed: summary.indexed,
      status: classified.status,
      canRefresh: classified.canRefresh,
      autoRefreshable: classified.autoRefreshable,
      chunkCount: summary.chunkCount,
      ...(title ? { title } : {}),
    };
  });

  return NextResponse.json({ available: true, results });
}
