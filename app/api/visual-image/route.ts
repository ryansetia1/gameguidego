import { isAllowedVisualImageUrl } from "@/lib/visual-image-proxy.js";

export const runtime = "nodejs";

/** Server-side fetch for wiki/CDN sprites blocked by hotlink protection. */
export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url")?.trim();
  if (!url || !isAllowedVisualImageUrl(url)) {
    return new Response("Invalid image URL", { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "GameGuideGo/1.0 (+https://gameguidego.vercel.app)",
        Accept: "image/*",
      },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!upstream.ok) {
      return new Response("Upstream image unavailable", { status: 502 });
    }
    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
      return new Response("Not an image", { status: 502 });
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new Response("Image fetch failed", { status: 502 });
  }
}
