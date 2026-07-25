import type { SupabaseClient } from "@supabase/supabase-js";

import { chunkGuide } from "@/lib/chunk-guide.js";
import { embedTexts } from "@/lib/embed";
import type { EmbedLogMeta } from "@/lib/embed-log";
import { toVectorString } from "@/lib/embed-cache";
import { cleanSnippet } from "@/lib/clean.js";
import {
  canonicalGamefaqsBundleUrl,
  gamefaqsExtractQuality,
  MIN_GAMEFAQS_GUIDE_CHARS,
  parseGamefaqsFaqUrl,
  parseGamefaqsGuideTitle,
} from "@/lib/gamefaqs-bundle.js";
import {
  extractGuidePage,
  isBlockedGuideContent,
  looksLikeHub,
} from "@/lib/tavily";
import { getServerClient } from "@/lib/supabase-server";
import { logTraceEvent } from "@/lib/trace";

const MIN_GUIDE_CHARS = 400;

/** Normalize a guide URL for storage and retrieval keys. */
export function normalizeGuideUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

export function isGuideRagAvailable(): boolean {
  return Boolean(getServerClient() && process.env.SUMOPOD_API_KEY);
}

export type IngestResult = {
  indexed: boolean;
  chunkCount: number;
  hubWarning: boolean;
  isBlocked?: boolean;
};

type IngestContext = {
  game?: string;
  platform?: string;
  userId?: string | null;
};

function embedLogFromContext(ctx?: IngestContext): EmbedLogMeta | undefined {
  if (!ctx?.game && !ctx?.platform && !ctx?.userId) return undefined;
  return {
    purpose: "ingest",
    game: ctx.game,
    platform: ctx.platform,
    userId: ctx.userId,
  };
}

function gamefaqsStorageUrl(rawUrl: string): string {
  const canonical = canonicalGamefaqsBundleUrl(rawUrl);
  return normalizeGuideUrl(canonical ?? rawUrl);
}

/** True when guide_chunks already has rows for this URL. */
export async function isGuideIndexed(guideUrl: string): Promise<boolean> {
  const supabase = getServerClient();
  if (!supabase) return false;
  try {
    const storageUrl = parseGamefaqsFaqUrl(guideUrl)
      ? gamefaqsStorageUrl(guideUrl)
      : normalizeGuideUrl(guideUrl);
    const { count, error } = await supabase
      .from("guide_chunks")
      .select("*", { count: "exact", head: true })
      .eq("guide_url", storageUrl);
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function guideChunkCharTotal(
  supabase: SupabaseClient,
  guideUrl: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("guide_chunks")
    .select("chunk_text")
    .eq("guide_url", guideUrl);
  if (error || !data) return 0;
  return data.reduce((sum, row) => sum + String(row.chunk_text ?? "").length, 0);
}

async function deleteGuideChunks(
  supabase: SupabaseClient,
  guideUrl: string,
): Promise<void> {
  await supabase.from("guide_chunks").delete().eq("guide_url", guideUrl);
}

async function insertGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  chunks: string[];
  embeddings: number[][];
}): Promise<{ indexed: boolean; chunkCount: number }> {
  const guideUrl = normalizeGuideUrl(input.guideUrl);
  if (!input.chunks.length) return { indexed: false, chunkCount: 0 };
  if (input.embeddings.length !== input.chunks.length) {
    console.error("Guide ingest embed count mismatch");
    return { indexed: false, chunkCount: 0 };
  }

  const rows = input.chunks.map((chunk_text, chunk_index) => ({
    guide_url: guideUrl,
    guide_bundle: null,
    chunk_index,
    chunk_text,
    embedding: toVectorString(input.embeddings[chunk_index]),
  }));

  const insertStart = Date.now();
  try {
    const { error } = await input.supabase.from("guide_chunks").insert(rows);
    if (error) {
      const { count } = await input.supabase
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", guideUrl)
        .is("guide_bundle", null);
      if ((count ?? 0) > 0) {
        void logTraceEvent(
          "ingest_db_insert",
          `Chunks already exist for ${guideUrl} (${count} rows)`,
          Date.now() - insertStart,
          { guideUrl, chunkCount: count, duplicate: true },
        );
        return { indexed: true, chunkCount: count ?? input.chunks.length };
      }
      void logTraceEvent(
        "ingest_db_insert",
        `Insert failed for ${guideUrl}: ${error.message}`,
        Date.now() - insertStart,
        { guideUrl, error: error.message },
      );
      console.error("Guide ingest insert failed:", error);
      return { indexed: false, chunkCount: 0 };
    }
  } catch (error) {
    void logTraceEvent(
      "ingest_db_insert",
      `Insert error for ${guideUrl}: ${error instanceof Error ? error.message : String(error)}`,
      Date.now() - insertStart,
      { guideUrl, error: true },
    );
    console.error("Guide ingest insert failed:", error);
    return { indexed: false, chunkCount: 0 };
  }

  void logTraceEvent(
    "ingest_db_insert",
    `Inserted ${input.chunks.length} chunks for ${guideUrl}`,
    Date.now() - insertStart,
    { guideUrl, chunkCount: input.chunks.length },
  );
  return { indexed: true, chunkCount: input.chunks.length };
}

async function storeGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  text: string;
  signal?: AbortSignal;
  embedLog?: EmbedLogMeta;
}): Promise<{ indexed: boolean; chunkCount: number }> {
  const chunks = chunkGuide(input.text);
  if (!chunks.length) return { indexed: false, chunkCount: 0 };

  void logTraceEvent(
    "ingest_chunk",
    `Chunked guide into ${chunks.length} pieces for ${input.guideUrl}`,
    undefined,
    { guideUrl: input.guideUrl, chunkCount: chunks.length },
  );

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks, input.signal, {
      purpose: "ingest",
      guideUrl: input.guideUrl,
      ...input.embedLog,
    });
  } catch (error) {
    void logTraceEvent(
      "ingest_embed_error",
      `Embedding failed for ${input.guideUrl}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { guideUrl: input.guideUrl, error: true },
    );
    console.error("Guide ingest embed failed:", error);
    return { indexed: false, chunkCount: 0 };
  }

  return insertGuideChunks({
    supabase: input.supabase,
    guideUrl: input.guideUrl,
    chunks,
    embeddings,
  });
}

async function ingestGuidePage(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  const supabase = getServerClient();
  if (!supabase || !process.env.SUMOPOD_API_KEY) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  const guideUrl = parseGamefaqsFaqUrl(rawUrl)
    ? gamefaqsStorageUrl(rawUrl)
    : normalizeGuideUrl(rawUrl);

  if (await isGuideIndexed(guideUrl)) {
    const isGamefaqs = Boolean(parseGamefaqsFaqUrl(guideUrl));
    if (isGamefaqs) {
      const totalChars = await guideChunkCharTotal(supabase, guideUrl);
      if (totalChars < MIN_GAMEFAQS_GUIDE_CHARS) {
        void logTraceEvent(
          "ingest_stale_purge",
          `Purging short GameFAQs chunks (${totalChars} chars) for re-ingest: ${guideUrl}`,
          undefined,
          { guideUrl, totalChars },
        );
        await deleteGuideChunks(supabase, guideUrl);
      } else {
        const { count } = await supabase
          .from("guide_chunks")
          .select("*", { count: "exact", head: true })
          .eq("guide_url", guideUrl);
        return { indexed: true, chunkCount: count ?? 0, hubWarning: false };
      }
    } else {
      const { count } = await supabase
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", guideUrl);
      return { indexed: true, chunkCount: count ?? 0, hubWarning: false };
    }
  }

  void logTraceEvent("ingest_start", `Ingesting guide: ${guideUrl}`, undefined, { guideUrl });
  const startMs = Date.now();
  const extracted = await extractGuidePage(guideUrl, signal);
  if (!extracted) {
    void logTraceEvent(
      "ingest_error",
      `Could not extract guide: ${guideUrl}`,
      Date.now() - startMs,
      { guideUrl, error: "Extraction failed" },
    );
    console.error("Guide ingest skipped: could not extract guide page", { guideUrl });
    return { indexed: false, chunkCount: 0, hubWarning: looksLikeHub(guideUrl) };
  }
  if (isBlockedGuideContent(extracted.content)) {
    void logTraceEvent(
      "ingest_blocked",
      `GameFAQs anti-bot blocked extract for ${guideUrl}`,
      Date.now() - startMs,
      { guideUrl },
    );
    return { indexed: false, chunkCount: 0, hubWarning: false, isBlocked: true };
  }

  const text = cleanSnippet(extracted.content);
  const isGamefaqs = Boolean(parseGamefaqsFaqUrl(guideUrl));
  if (isGamefaqs) {
    const quality = gamefaqsExtractQuality(text);
    if (quality.insufficient) {
      void logTraceEvent(
        "ingest_insufficient",
        `GameFAQs extract too thin for ${guideUrl} (${quality.reason}, ${text.length} chars)`,
        Date.now() - startMs,
        { guideUrl, reason: quality.reason, charCount: text.length },
      );
      return { indexed: false, chunkCount: 0, hubWarning: true };
    }
  }

  const hubWarning = looksLikeHub(guideUrl) || text.length < MIN_GUIDE_CHARS;
  const stored = await storeGuideChunks({
    supabase,
    guideUrl,
    text,
    signal,
    embedLog: embedLogFromContext(ctx),
  });
  if (!stored.indexed) {
    void logTraceEvent(
      "ingest_error",
      `Failed to store guide chunks for: ${guideUrl}`,
      Date.now() - startMs,
      { guideUrl, error: "Store failed", hubWarning: true },
    );
    return { indexed: false, chunkCount: 0, hubWarning: true };
  }

  // ponytail: title parse from extract text only — direct GameFAQs fetch is Cloudflare-blocked.
  const parsed = parseGamefaqsFaqUrl(guideUrl);
  if (parsed) {
    const title = parseGamefaqsGuideTitle(extracted.content, parsed);
    if (title) {
      try {
        await supabase.from("guide_bundle_cache").upsert({
          bundle_key: guideUrl,
          data: { title },
        });
      } catch {
        // best-effort display title
      }
    }
  }

  void logTraceEvent(
    "ingest_complete",
    `Successfully ingested guide: ${guideUrl}`,
    Date.now() - startMs,
    { guideUrl, chunkCount: stored.chunkCount, hubWarning },
  );
  return { indexed: true, chunkCount: stored.chunkCount, hubWarning };
}

/**
 * Fetch, chunk, embed, and store a preferred guide URL.
 * GameFAQs URLs normalize to the FAQ root; Tavily extract tries ?print=1 first.
 */
export async function ensureGuideIngested(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  if (rawUrl.startsWith("upload://")) {
    const supabase = getServerClient();
    if (!supabase) return { indexed: false, chunkCount: 0, hubWarning: false };
    const { count } = await supabase
      .from("guide_chunks")
      .select("*", { count: "exact", head: true })
      .eq("guide_url", rawUrl);
    return { indexed: (count ?? 0) > 0, chunkCount: count ?? 0, hubWarning: false };
  }
  return ingestGuidePage(rawUrl, signal, ctx);
}

/**
 * Ingest a guide from pre-extracted text (e.g. uploaded PDF/TXT/MD).
 * Skips Tavily extract — text is already available. Idempotent per guideUrl.
 */
export async function ingestGuideFromText(input: {
  guideUrl: string;
  text: string;
  signal?: AbortSignal;
  ctx?: IngestContext;
}): Promise<IngestResult> {
  const supabase = getServerClient();
  if (!supabase || !process.env.SUMOPOD_API_KEY) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  if (await isGuideIndexed(input.guideUrl)) {
    const { count } = await supabase
      .from("guide_chunks")
      .select("*", { count: "exact", head: true })
      .eq("guide_url", input.guideUrl);
    return { indexed: true, chunkCount: count ?? 0, hubWarning: false };
  }

  void logTraceEvent(
    "ingest_upload_start",
    `Ingesting uploaded guide: ${input.guideUrl}`,
    undefined,
    { guideUrl: input.guideUrl },
  );
  const startMs = Date.now();

  const stored = await storeGuideChunks({
    supabase,
    guideUrl: input.guideUrl,
    text: input.text,
    signal: input.signal,
    embedLog: embedLogFromContext(input.ctx),
  });

  if (!stored.indexed) {
    void logTraceEvent(
      "ingest_upload_error",
      `Failed to store uploaded guide: ${input.guideUrl}`,
      Date.now() - startMs,
      { guideUrl: input.guideUrl },
    );
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  void logTraceEvent(
    "ingest_upload_complete",
    `Uploaded guide ingested: ${input.guideUrl}`,
    Date.now() - startMs,
    { guideUrl: input.guideUrl, chunkCount: stored.chunkCount },
  );
  return { indexed: true, chunkCount: stored.chunkCount, hubWarning: false };
}
