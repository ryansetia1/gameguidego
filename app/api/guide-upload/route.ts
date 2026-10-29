import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase-server";
import {
  bearerToken,
  createAuthedSupabase,
  getAuthedUser,
} from "@/lib/player-memory-server";
import { checkUploadIdentity, otherRoomReferences, ownsUploadKey } from "@/lib/upload-auth.js";

import { parseGuideFile } from "@/lib/parse-guide-file";
import {
  ingestGuideFromText,
  isGuideRagAvailable,
  normalizeGuideUrl,
  purgeGuideVerified,
} from "@/lib/guide-ingest";
import { isBodyTooLarge, isUploadTooLarge, UPLOAD_TOO_LARGE_MSG } from "@/lib/upload-limit";
import { runWithTrace, logTraceEvent } from "@/lib/trace";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Verified uid + the caller's own client from the Bearer token, or an error response. */
async function authenticate(request: Request, signInMsg = "Sign in to upload guide files.") {
  const supabase = createAuthedSupabase(bearerToken(request));
  const noSignIn = NextResponse.json({ error: signInMsg }, { status: 401 });
  if (!supabase) return { res: noSignIn };
  const { data, error } = await supabase.auth.getUser();
  // An auth outage (network / 5xx) is not a sign-out: do not tell a signed-in user to sign in.
  if (error && (!error.status || error.status >= 500)) {
    return { res: NextResponse.json({ error: "Couldn't check your sign-in. Try again in a moment." }, { status: 503 }) };
  }
  const uid = data?.user ? data.user.id : "";
  return uid ? { uid, supabase } : { res: noSignIn };
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

  // Auth before buffering the body, so an unauthenticated caller costs nothing.
  const authed = await authenticate(request);
  if ("res" in authed) return authed.res;
  const userId = authed.uid;

  // Refuse an oversize body before buffering it.
  if (isBodyTooLarge(request.headers.get("content-length"))) {
    return NextResponse.json({ error: UPLOAD_TOO_LARGE_MSG }, { status: 413 });
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

  if (isUploadTooLarge(file.size)) {
    return NextResponse.json(
      { error: UPLOAD_TOO_LARGE_MSG },
      { status: 413 },
    );
  }

  const id = checkUploadIdentity(userId, formData.get("userId"));
  if (!id.ok) return NextResponse.json({ error: id.error }, { status: id.status });

  const game = typeof formData.get("game") === "string" ? (formData.get("game") as string).slice(0, 120) : undefined;
  const platform = typeof formData.get("platform") === "string" ? (formData.get("platform") as string).slice(0, 80) : undefined;

  // The key has no game in it: refuse to overwrite a file another of this user's games uses.
  const guideUrl = normalizeGuideUrl(`upload://${userId}/${file.name}`);
  const refs = await otherRoomReferences(authed.supabase, guideUrl, game ?? "", platform ?? "");
  if (refs === null) {
    return NextResponse.json({ error: "Couldn't check your other games. Try again in a moment." }, { status: 500 });
  }
  if (refs > 0) {
    return NextResponse.json(
      { error: `You already uploaded a file named "${file.name}" for another game. Rename it and upload again.` },
      { status: 409 },
    );
  }

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

    if (result.busy) {
      return NextResponse.json(
        { error: "Another upload of that file is still running. Try again when it finishes." },
        { status: 409 },
      );
    }

    if (!result.indexed) {
      const msg = result.lostOld
        ? "Couldn't index the new file, and the old copy is gone. Upload it again."
        : "Could not index that guide. Try again in a moment.";
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

  const authed = await authenticate(request, "Sign in again to remove this file.");
  if ("res" in authed) return authed.res;

  let body: { guideUrl?: unknown; userId?: unknown; game?: unknown; platform?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const id = checkUploadIdentity(authed.uid, body?.userId);
  if (!id.ok) return NextResponse.json({ error: id.error }, { status: id.status });

  let guideUrl = "";
  try {
    if (typeof body.guideUrl === "string") guideUrl = normalizeGuideUrl(body.guideUrl);
  } catch {}
  if (!ownsUploadKey(authed.uid, guideUrl)) {
    return NextResponse.json({ error: "Unauthorized or invalid guideUrl" }, { status: 403 });
  }

  // Another game of this user still uses the file: uploads cannot be re-extracted, so keep it.
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const refs = await otherRoomReferences(authed.supabase, guideUrl, str(body.game, 120), str(body.platform, 80));
  if (refs === null) {
    return NextResponse.json({ error: "Couldn't check your other games. Try again in a moment." }, { status: 500 });
  }
  if (refs > 0) return NextResponse.json({ success: true, kept: true, guideUrl });

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
