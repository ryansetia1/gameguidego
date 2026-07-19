import { NextResponse } from "next/server";

import { discoverGamefaqsBundleResolved } from "@/lib/gamefaqs-discover";
import { cleanGuideUrl } from "@/lib/guide-urls.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const preferredUrl = cleanGuideUrl(searchParams.get("url"));

  if (!preferredUrl) {
    return NextResponse.json({ error: "Missing guide URL." }, { status: 400 });
  }

  try {
    const refresh = searchParams.get("refresh") === "1";
    const preview = await discoverGamefaqsBundleResolved(preferredUrl, request.signal, {
      refresh,
    });
    return NextResponse.json(preview);
  } catch (error) {
    console.error("Guide bundle preview failed:", error);
    const timedOut =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return NextResponse.json(
      { error: timedOut ? "Preview took too long. Try again." : "Couldn't preview that guide." },
      { status: timedOut ? 504 : 502 },
    );
  }
}
