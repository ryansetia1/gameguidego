import { NextResponse } from "next/server";

import { VGMapsError, fetchVGMapsImage } from "@/lib/vgmaps-cache";
import { canonicalVGMapsUrl, isAllowedVGMapsImageUrl } from "@/lib/vgmaps-parser.js";

export const runtime = "nodejs";

// Same-origin proxy for a VGMaps map image (no canvas tainting, cacheable offline).
// Only VGMaps hosts + image extensions, every redirect hop re-checked, raster types only,
// 30 MB cap. No login.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get("url");
  if (!isAllowedVGMapsImageUrl(imageUrl)) {
    return NextResponse.json({ error: "Not a VGMaps map image." }, { status: 400 });
  }
  const rawReferer = searchParams.get("referer");
  const referer = rawReferer ? canonicalVGMapsUrl(rawReferer) : "https://www.vgmaps.com/";
  if (!referer) return NextResponse.json({ error: "Not a VGMaps page." }, { status: 400 });

  try {
    const image = await fetchVGMapsImage(imageUrl as string, referer.replace(/#.*$/, ""));
    const headers: Record<string, string> = {
      "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=2592000, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    if (image.contentLength) headers["Content-Length"] = image.contentLength;
    return new Response(image.body, { headers });
  } catch (err) {
    if (err instanceof VGMapsError && (err.status === 400 || err.status === 413)) {
      const error = err.status === 413 ? "Map is over 30 MB." : err.message;
      return NextResponse.json({ error }, { status: err.status });
    }
    console.error("VGMaps image failed:", err);
    return NextResponse.json({ error: "Couldn't load that map from VGMaps." }, { status: 502 });
  }
}
