import { after } from "next/server";

import { formatEmbedPrefix } from "@/lib/chunk-guide.js";
import { embedTexts, isEmbedModelAvailable, QWEN_MODEL_TAG, SUMOPOD_MODEL_TAG } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import { singleFlight } from "@/lib/guide-ingest";
import {
  REEMBED_BATCH,
  reembedRemainingMs,
  shouldReembed,
} from "@/lib/guide-reembed-rules.js";
import { getServiceClient } from "@/lib/supabase-server";
import { getTraceId, logTraceEvent, runWithTrace } from "@/lib/trace";

type Meta = { game?: string; platform?: string; userId?: string | null; requestStartMs?: number };

// A deploy before db/embed-reembed.sql: remember the miss so turns do not each issue a failing RPC.
const SQL_MISSING_CODES = new Set(["PGRST202", "42883", "42P01"]);
const SQL_MISSING_TTL_MS = 10 * 60_000;
let sqlMissingUntil = 0;

function skip(guideUrl: string, reason: string, extra?: Record<string, unknown>) {
  void logTraceEvent("reembed_skip", `Re-embed skipped (${reason}): ${guideUrl}`, undefined, {
    guideUrl,
    reason,
    ...extra,
  });
}

/**
 * Convert one legacy Sumopod guide to Qwen in the background. Writes STAGING columns only, then
 * flips the whole guide in one SQL function; the live index is never touched before that.
 * Fails open: missing key, missing SQL (db/embed-reembed.sql), cooldown/cap or any error just
 * leaves the guide as it was (lexical-only), never an error for the player.
 */
async function reembedGuide(guideUrl: string, meta: Meta): Promise<void> {
  if (Date.now() < sqlMissingUntil) return;
  const svc = getServiceClient();
  if (!svc) return skip(guideUrl, "no_service_key");
  const startMs = Date.now();
  // Budget is anchored to the originating request (after() runs once the answer is done);
  // checked before claiming so a no-time skip costs no cooldown or cap.
  const requestStartMs = meta.requestStartMs ?? startMs;
  if (reembedRemainingMs(startMs, startMs, requestStartMs) === null) return skip(guideUrl, "no_time");

  const { data: claim, error: claimError } = await svc.rpc("claim_guide_reembed", {
    p_guide_url: guideUrl,
  });
  if (claimError) {
    const missing = SQL_MISSING_CODES.has(claimError.code);
    if (missing) sqlMissingUntil = Date.now() + SQL_MISSING_TTL_MS;
    return skip(guideUrl, missing ? "sql_missing" : "claim_error", { error: claimError.message.slice(0, 200) });
  }
  if (!claim?.ok) return skip(guideUrl, String(claim?.reason ?? "refused"));
  const runId = claim.run_id as number;

  let staged = 0;
  let status = "partial";
  try {
    void logTraceEvent("reembed_start", `Re-embedding ${guideUrl} to Qwen`, undefined, { guideUrl, runId });
    for (;;) {
      // Resumable: only rows without a staged vector, highest chunk_index first.
      const { data: rows, error } = await svc
        .from("guide_chunks")
        .select("id, chunk_text, section_path, section_confidence")
        .eq("guide_url", guideUrl)
        .eq("embed_model", SUMOPOD_MODEL_TAG)
        .is("embedding_next", null)
        .order("chunk_index", { ascending: false })
        .limit(REEMBED_BATCH);
      if (error) throw error;
      if (!rows?.length) break;

      const timeout = reembedRemainingMs(startMs, Date.now(), requestStartMs);
      if (timeout === null) {
        void logTraceEvent("reembed_progress", "Re-embed budget used, next query resumes", Date.now() - startMs, {
          guideUrl,
          staged,
        });
        return;
      }
      // Same input shape as ingest (section breadcrumb + text); documents get no Qwen instruction.
      const inputs = rows.map((r) => `${formatEmbedPrefix(r)}${r.chunk_text}`);
      const { vectors } = await embedTexts(
        inputs,
        undefined,
        { purpose: "ingest", guideUrl, ...meta },
        { model: QWEN_MODEL_TAG, ingestTimeoutMs: timeout },
      );
      if (vectors.length !== rows.length) throw new Error("embed count mismatch");
      const { data: n, error: stageError } = await svc.rpc("stage_guide_embeddings", {
        p_guide_url: guideUrl,
        p_from_model: SUMOPOD_MODEL_TAG,
        p_to_model: QWEN_MODEL_TAG,
        p_rows: rows.map((r, i) => ({ id: r.id, v: toVectorString(vectors[i]) })),
      });
      if (stageError) throw stageError;
      // Fewer than sent means rows vanished or were replaced mid-run: stop, do not flip.
      if (n !== rows.length) throw new Error(`staged ${n}/${rows.length}`);
      staged += n;
    }

    const { data: flipped, error: flipError } = await svc.rpc("flip_guide_embeddings", {
      p_guide_url: guideUrl,
      p_from_model: SUMOPOD_MODEL_TAG,
      p_to_model: QWEN_MODEL_TAG,
    });
    if (flipError) throw flipError;
    status = flipped > 0 ? "complete" : "failed";
    void logTraceEvent(
      flipped > 0 ? "reembed_flip" : "reembed_flip_refused",
      flipped > 0 ? `Flipped ${flipped} chunks to Qwen` : "Flip refused (guide changed or not fully staged)",
      Date.now() - startMs,
      { guideUrl, rows: flipped, staged },
    );
  } catch (error) {
    status = "failed";
    void logTraceEvent("reembed_error", `Re-embed failed: ${String(error).slice(0, 200)}`, undefined, {
      guideUrl,
      error: true,
      staged,
    });
  } finally {
    await svc.rpc("finish_guide_reembed", { p_run_id: runId, p_status: status, p_rows: staged });
  }
}

/** Kick off a background conversion when the guide's model is the unavailable legacy Sumopod. */
export function maybeStartReembed(guideUrl: string, model: string, meta: Meta = {}): void {
  if (
    !shouldReembed({
      model,
      sumopodUp: isEmbedModelAvailable(SUMOPOD_MODEL_TAG),
      qwenUp: isEmbedModelAvailable(QWEN_MODEL_TAG),
    })
  ) {
    return;
  }
  const traceId = getTraceId();
  const task = () =>
    singleFlight(`reembed:${guideUrl}`, () => reembedGuide(guideUrl, meta)).catch((error) =>
      console.error("Guide re-embed failed:", error),
    );
  const run = () => (traceId ? runWithTrace(traceId, task) : task());
  try {
    after(run);
  } catch {
    // Outside a request scope (scripts): fire and forget.
    void run();
  }
}
