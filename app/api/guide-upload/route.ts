import { NextResponse } from "next/server";

import { parseGuideFile } from "@/lib/parse-guide-file";
import {
  ingestGuideFromText,
  isGuideRagAvailable,
  normalizeGuideUrl,
} from "@/lib/guide-ingest";
import { runWithTrace, logTraceEvent } from "@/lib/trace";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request) {
  if (!isGuideRagAvailable()) {
    return NextResponse.json(
      { error: "Guide RAG is not configured on this server." },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Could not read the upload. Send multipart/form-data." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File) || !file.name) {
    return NextResponse.json(
      { error: "Missing file." },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 10 MB.` },
      { status: 413 },
    );
  }

  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId.trim()) {
    return NextResponse.json(
      { error: "Sign in to upload guide files." },
      { status: 401 },
    );
  }

  const game = typeof formData.get("game") === "string" ? (formData.get("game") as string).slice(0, 120) : undefined;
  const platform = typeof formData.get("platform") === "string" ? (formData.get("platform") as string).slice(0, 80) : undefined;

  const traceId = request.headers.get("X-Trace-Id") || crypto.randomUUID();

  return runWithTrace(traceId, async () => {
    let parsed;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      parsed = await parseGuideFile(buffer, file.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not parse that file.";
      return NextResponse.json({ error: msg }, { status: 422 });
    }

    const guideUrl = normalizeGuideUrl(`upload://${userId.trim()}/${file.name}`);

    await logTraceEvent("guide_upload_received", `Uploaded ${parsed.fileType.toUpperCase()} guide: ${file.name} (${(file.size / 1024).toFixed(0)} KB, ${parsed.text.length} chars)`, undefined, {
      filename: file.name,
      fileType: parsed.fileType,
      fileSize: file.size,
      textLength: parsed.text.length,
    });

    const result = await ingestGuideFromText({
      guideUrl,
      text: parsed.text,
      signal: request.signal,
      ctx: { game, platform, userId: userId.trim() },
    });

    return NextResponse.json({
      indexed: result.indexed,
      chunkCount: result.chunkCount,
      guideUrl,
      fileType: parsed.fileType,
      filename: file.name,
    });
  });
}
