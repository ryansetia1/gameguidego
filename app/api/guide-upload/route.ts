import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase-server";
import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";
import { checkUploadIdentity, ownsUploadKey } from "@/lib/upload-auth.js";

import { parseGuideFile } from "@/lib/parse-guide-file";
import {
  ingestGuideFromText,
  isGuideRagAvailable,
  normalizeGuideUrl,
  purgeGuideVerified,
} from "@/lib/guide-ingest";
import { runWithTrace, logTraceEvent } from "@/lib/trace";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Verified uid from the Bearer token, or an error response (401 bad/missing token, 403 uid mismatch). */
async function authenticate(request: Request, clientUid: unknown) {
  const supabase = createAuthedSupabase(bearerToken(request));
  const auth = supabase ? await getAuthedUser(supabase) : null;
  const uid = auth && "user" in auth ? auth.user.id : "";
  const id = checkUploadIdentity(uid, clientUid);
  if (!id.ok) return { res: NextResponse.json({ error: id.error }, { status: id.status }) };
  return { uid };
}

const NO_SERVICE = () =>
  NextResponse.json({ error: "Guide uploads are unavailable right now." }, { status: 503 });

export async function POST(request: Request) {
  if (!isGuideRagAvailable()) {
    return NextResponse.json(
      { error: "Guide RAG is not configured on this server." },
      { status: 503 },
    );
  }

  if (!getServiceClient()) return NO_SERVICE();

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

  const authed = await authenticate(request, formData.get("userId"));
  if ("res" in authed) return authed.res;
  const userId = authed.uid;

  const game = typeof formData.get("game") === "string" ? (formData.get("game") as string).slice(0, 120) : undefined;
  const platform = typeof formData.get("platform") === "string" ? (formData.get("platform") as string).slice(0, 80) : undefined;

  const traceId = request.headers.get("X-Trace-Id") || crypto.randomUUID();

  return runWithTrace(traceId, async () => {
    await logTraceEvent("upload_start", `Started uploading and parsing file: ${file.name}`, undefined, {
      filename: file.name,
      game,
      platform,
    });

    let parsed;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      parsed = await parseGuideFile(buffer, file.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not parse that file.";
      await logTraceEvent("upload_error", `Failed to parse file: ${msg}`, undefined, { error: msg });
      return NextResponse.json({ error: msg }, { status: 422 });
    }

    const guideUrl = normalizeGuideUrl(`upload://${userId}/${file.name}`);

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
      ctx: { game, platform, userId },
      replace: true,
    });

    if (!result.indexed) {
      const msg = "Could not index that guide. Try again in a moment.";
      await logTraceEvent("upload_error", `Guide ingest failed: ${guideUrl}`, undefined, {
        guideUrl,
        textLength: parsed.text.length,
      });
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    await logTraceEvent("upload_complete", `Successfully indexed ${result.chunkCount} chunks.`, undefined, {
      indexed: result.indexed,
      chunkCount: result.chunkCount,
      guideUrl,
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

export async function DELETE(request: Request) {
  if (!isGuideRagAvailable()) {
    return NextResponse.json(
      { error: "Guide RAG is not configured on this server." },
      { status: 503 },
    );
  }
  const service = getServiceClient();
  if (!service) return NO_SERVICE();

  let body: { guideUrl?: unknown; userId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const authed = await authenticate(request, body?.userId);
  if ("res" in authed) return authed.res;

  let guideUrl = "";
  try {
    if (typeof body.guideUrl === "string") guideUrl = normalizeGuideUrl(body.guideUrl);
  } catch {}
  if (!ownsUploadKey(authed.uid, guideUrl)) {
    return NextResponse.json({ error: "Unauthorized or invalid guideUrl" }, { status: 403 });
  }

  const traceId = request.headers.get("X-Trace-Id") || crypto.randomUUID();
  return runWithTrace(traceId, async () => {
    await logTraceEvent("upload_delete_start", `Deleting guide: ${guideUrl}`, undefined, { guideUrl });

    // Exact-key delete, verified by recount; only "gone" is success.
    const state = await purgeGuideVerified(guideUrl, service);
    if (state !== "gone") {
      await logTraceEvent("upload_delete_error", `Guide delete not confirmed (${state}): ${guideUrl}`, undefined, { guideUrl, state });
      return NextResponse.json({ error: "Failed to delete guide" }, { status: 500 });
    }

    await logTraceEvent("upload_delete_complete", `Successfully deleted guide: ${guideUrl}`, undefined, { guideUrl });
    return NextResponse.json({ success: true, guideUrl });
  });
}
