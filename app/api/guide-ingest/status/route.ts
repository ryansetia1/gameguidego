import { NextResponse } from "next/server";

import {
  cleanGuideUrl,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import {
  getGuideDisplayTitle,
  isGuideIndexed,
  isGuideRagAvailable,
} from "@/lib/guide-ingest";

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
      results: urls.map((url) => ({ url, indexed: false })),
    });
  }

  const results = await Promise.all(
    urls.map(async (url) => {
      const indexed = await isGuideIndexed(url);
      const title = indexed ? await getGuideDisplayTitle(url) : null;
      return {
        url,
        indexed,
        ...(title ? { title } : {}),
      };
    }),
  );

  return NextResponse.json({ available: true, results });
}
