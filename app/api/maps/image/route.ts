import { NextResponse } from "next/server";

import { VGMapsError, fetchVGMapsImage, resolveMapImageRequest } from "@/lib/vgmaps-cache";

export const runtime = "nodejs";
// Covers the 120s upstream image timeout in lib/vgmaps-cache.ts.
export const maxDuration = 130;

// Same-origin proxy for a VGMaps map image (no canvas tainting, cacheable offline).
// GET ?url=<imageUrl>&game=<atlas game url>, exactly that: the image must be one the game's
// VGMaps page lists, so every CDN cache key is a real map. Every redirect hop re-checked,
// raster types only, 30 MB cap. No login.
export async function GET(request: Request) {
  try {
    const { imageUrl, referer } = await resolveMapImageRequest(new URL(request.url).search);
    const image = await fetchVGMapsImage(imageUrl, referer);
    const headers: Record<string, string> = {
      "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=86400",
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
