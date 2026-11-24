import { NextResponse } from "next/server";

import { getCachedVGMapsDirectory, getCachedVGMapsMaps } from "@/lib/vgmaps-cache";
import { canonicalVGMapsUrl } from "@/lib/vgmaps-parser.js";

export const runtime = "nodejs";

// One game's maps (title, size, author, image URL) from its VGMaps platform page.
// Only game URLs from the Atlas index are accepted, which keeps the cache keyed by real games.
export async function GET(request: Request) {
  const url = canonicalVGMapsUrl(new URL(request.url).searchParams.get("url"));
  if (!url) return NextResponse.json({ error: "Not a VGMaps link." }, { status: 400 });

  try {
    const entries = await getCachedVGMapsDirectory();
    if (!entries.some((entry) => entry.url === url)) {
      return NextResponse.json({ error: "That game isn't in the VGMaps atlas." }, { status: 400 });
    }
    const maps = await getCachedVGMapsMaps(url);
    return NextResponse.json(
      { pageUrl: url, maps, available: true },
      // A game with no maps yet is rechecked sooner.
      { headers: { "Cache-Control": `public, max-age=${maps.length ? 3600 : 300}` } },
    );
  } catch (err) {
    console.error("VGMaps list failed:", err);
    return NextResponse.json({ pageUrl: url, maps: [], available: false });
  }
}
