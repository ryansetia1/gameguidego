import type { SupabaseClient } from "@supabase/supabase-js";

import { chunkGuideWithMeta, formatEmbedPrefix } from "@/lib/chunk-guide.js";
import { embedTexts, isEmbedConfigured, SUMOPOD_MODEL_TAG } from "@/lib/embed";
import type { EmbedLogMeta } from "@/lib/embed-log";
import { toVectorString } from "@/lib/embed-cache";
import { cleanSnippet } from "@/lib/clean.js";
import {
  canonicalGamefaqsBundleUrl,
  gamefaqsExtractQuality,
  parseGamefaqsFaqUrl,
} from "@/lib/gamefaqs-bundle.js";
import {
  extractGuidePage,
  isBlockedGuideContent,
  looksLikeHub,
} from "@/lib/tavily";
import { fetchGamefaqsWaybackRootTitle } from "@/lib/wayback.js";
import { parseGuideTitleFromExtract } from "@/lib/guide-title.js";
import { uploadedGuideFilename } from "@/lib/guide-urls.js";
import { getServerClient, getServiceClient } from "@/lib/supabase-server";
import { logTraceEvent } from "@/lib/trace";

const MIN_GUIDE_CHARS = 400;
// ponytail: single bulk insert of 1k+ vector rows hits Supabase statement timeout (~8s);
// 50-row batches still timed out on a 1093-chunk guide, so keep batches small.
const GUIDE_CHUNK_INSERT_BATCH = 25;

// One ingest per guide_url per server instance; concurrent callers share the promise.
// ponytail: cross-instance race (two serverless instances), add a guide_ingest_lease table
// (claim via insert ... on conflict where expires_at < now()) if it shows up.
const inflightIngests = new Map<string, Promise<unknown>>();
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflightIngests.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run().finally(() => inflightIngests.delete(key));
  inflightIngests.set(key, p);
  return p;
}

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
  return Boolean(getServerClient() && isEmbedConfigured());
}

export type IngestResult = {
  indexed: boolean;
  chunkCount: number;
  hubWarning: boolean;
  isBlocked?: boolean;
  /** Every embedding provider failed; the guide is fine, retry later. */
  embedFailed?: boolean;
  title?: string;
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

/** Stable DB/cache key for a preferred guide URL. */
export function guideStorageKey(rawUrl: string): string {
  return parseGamefaqsFaqUrl(rawUrl)
    ? gamefaqsStorageUrl(rawUrl)
    : normalizeGuideUrl(rawUrl);
}

/** Cached display title from a prior ingest (guide_bundle_cache). */
export async function getGuideDisplayTitle(guideUrl: string): Promise<string | null> {
  const supabase = getServerClient();
  if (!supabase) return null;
  const storageUrl = guideStorageKey(guideUrl);
  try {
    const { data } = await supabase
      .from("guide_bundle_cache")
      .select("data")
      .eq("bundle_key", storageUrl)
      .maybeSingle();
    const cached = (data?.data as { title?: string } | null)?.title;
    if (typeof cached === "string" && cached.trim()) return cached.trim();

    if (guideUrl.startsWith("upload://")) {
      const filename = uploadedGuideFilename(guideUrl);
      return filename || null;
    }

    // ponytail: Wayback multi-section ingest is plain text — title lives in root HTML only.
    if (!parseGamefaqsFaqUrl(guideUrl) || !(await isGuideIndexed(guideUrl))) return null;
    const title = await fetchGamefaqsWaybackRootTitle(storageUrl);
    if (!title) return null;
    await persistGuideTitle(supabase, storageUrl, title);
    return title;
  } catch {
    return null;
  }
}

/** Batch-read cached guide titles keyed by normalized URL. */
export async function getGuideDisplayTitles(
  urls: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(urls.map((url) => guideStorageKey(url)))];
  await Promise.all(
    unique.map(async (url) => {
      const title = await getGuideDisplayTitle(url);
      if (title) out.set(url, title);
    }),
  );
  return out;
}

async function persistGuideTitle(
  supabase: SupabaseClient,
  guideUrl: string,
  title: string,
): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;
  try {
    await supabase.from("guide_bundle_cache").upsert({
      bundle_key: guideUrl,
      data: { title: trimmed },
    });
  } catch {
    // best-effort display title
  }
  return trimmed;
}

async function indexedGuideCacheHit(
  supabase: SupabaseClient,
  guideUrl: string,
): Promise<IngestResult> {
  const { count } = await supabase
    .from("guide_chunks")
    .select("*", { count: "exact", head: true })
    .eq("guide_url", guideUrl);
  const title = await getGuideDisplayTitle(guideUrl);
  return {
    indexed: true,
    chunkCount: count ?? 0,
    hubWarning: false,
    ...(title ? { title } : {}),
  };
}

async function cacheGuideTitleFromExtract(
  supabase: SupabaseClient,
  guideUrl: string,
  rawContent: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let title = parseGuideTitleFromExtract(guideUrl, rawContent);
  if (!title && parseGamefaqsFaqUrl(guideUrl)) {
    title = (await fetchGamefaqsWaybackRootTitle(guideUrl, signal)) || "";
  }
  if (!title) return undefined;
  return persistGuideTitle(supabase, guideStorageKey(guideUrl), title);
}

/**
 * True when the guide's chunk 0 exists. Inserts run in reverse batch order, so
 * chunk 0 lands last: a run killed mid-insert never looks indexed and re-ingests.
 */
export async function guideIndexedIn(supabase: SupabaseClient, storageUrl: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("guide_chunks")
    .select("*", { count: "exact", head: true })
    .eq("guide_url", storageUrl)
    .eq("chunk_index", 0);
  return !error && (count ?? 0) > 0;
}

/** True when guide_chunks holds a complete index (chunk 0 present) for this URL. */
export async function isGuideIndexed(guideUrl: string): Promise<boolean> {
  const supabase = getServerClient();
  if (!supabase) return false;
  try {
    const storageUrl = parseGamefaqsFaqUrl(guideUrl)
      ? gamefaqsStorageUrl(guideUrl)
      : normalizeGuideUrl(guideUrl);
    return await guideIndexedIn(supabase, storageUrl);
  } catch {
    return false;
  }
}

async function guideNeedsOutlineReingest(
  supabase: SupabaseClient,
  guideUrl: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("guide_chunks")
    .select("section_confidence")
    .eq("guide_url", guideUrl)
    .limit(1)
    .maybeSingle();
  if (error || !data) return false;
  return data.section_confidence == null;
}

async function guideChunkText(
  supabase: SupabaseClient,
  guideUrl: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("guide_chunks")
    .select("chunk_text")
    .eq("guide_url", guideUrl)
    .order("chunk_index");
  // null = unknown (read error); callers must never purge on it.
  if (error || !data) return null;
  return data.map((row) => String(row.chunk_text ?? "")).join("\n");
}

/**
 * Delete a guide's rows (from `fromIndex` up when given). guide_chunks has no anon DELETE
 * policy (and must not get one), so callers pass the service-role client; with the anon
 * client this silently removes 0 rows.
 */
async function deleteGuideChunks(
  supabase: SupabaseClient,
  guideUrl: string,
  fromIndex?: number,
): Promise<void> {
  let q = supabase.from("guide_chunks").delete().eq("guide_url", guideUrl);
  if (fromIndex !== undefined) q = q.gte("chunk_index", fromIndex);
  await q;
}

/** Client for chunk deletes: service role. Null when SUPABASE_SERVICE_ROLE_KEY is unset. */
function chunkWriter(fallback: SupabaseClient): SupabaseClient {
  return getServiceClient() ?? fallback;
}

/** Row count for a guide (all chunks, or chunk 0 only). Null on a read error. */
async function countGuideRows(
  client: SupabaseClient,
  guideUrl: string,
  chunk0Only = false,
): Promise<number | null> {
  try {
    let q = client.from("guide_chunks").select("*", { count: "exact", head: true }).eq("guide_url", guideUrl);
    if (chunk0Only) q = q.eq("chunk_index", 0);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

export type PurgeState = "gone" | "kept" | "unknown";

/**
 * Delete a guide's rows with the service client and VERIFY by recount. Never deletes
 * without a service key. gone = verified empty; kept = rows remain (or no key), serve the old
 * index; unknown = the recount failed, so the guide may be empty: treat as not indexed.
 */
export async function purgeGuideVerified(
  guideUrl: string,
  service: SupabaseClient | null = getServiceClient(),
): Promise<PurgeState> {
  if (!service) {
    console.error("Guide purge skipped: SUPABASE_SERVICE_ROLE_KEY is not set", { guideUrl });
    return "kept";
  }
  await deleteGuideChunks(service, guideUrl).catch(() => {});
  const left = await countGuideRows(service, guideUrl);
  return left === null ? "unknown" : left === 0 ? "gone" : "kept";
}

/** Resolve null when `signal` aborts, so a caller can stop waiting while the shared work keeps running. */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export type LeftoverState = "clear" | "cached" | "blocked";

/**
 * Before any extract/embed spend: clear rows of an unindexed guide (a killed earlier run left
 * them without chunk 0). Deletes ONLY when chunk 0 is positively confirmed absent and leftovers
 * positively exist; any read error means no delete and no spend.
 *   clear   = nothing left, safe to ingest
 *   cached  = chunk 0 exists, the guide is indexed (never delete)
 *   blocked = unknown state or rows that cannot be removed (no service key, failed delete):
 *             skip the spend, the unique index would block the insert anyway
 * `reader` is the anon client, used for the checks when there is no service key.
 */
export async function clearGuideLeftovers(
  service: SupabaseClient | null,
  reader: SupabaseClient,
  guideUrl: string,
): Promise<LeftoverState> {
  const client = service ?? reader;
  const chunk0 = await countGuideRows(client, guideUrl, true);
  if (chunk0 === null) return "blocked";
  if (chunk0 > 0) return "cached";
  const before = await countGuideRows(client, guideUrl);
  if (before === null) return "blocked";
  if (before === 0) return "clear";
  if (!service) {
    console.error("Guide has leftover chunks and no SUPABASE_SERVICE_ROLE_KEY to clear them, skipping ingest spend", { guideUrl, before });
    void logTraceEvent("ingest_cleanup_failed", `Leftover chunks and no service key for ${guideUrl}`, undefined, { guideUrl, before, reason: "no_service_key" });
    return "blocked";
  }
  await deleteGuideChunks(service, guideUrl).catch(() => {});
  const after = await countGuideRows(service, guideUrl);
  if (after === 0) return "clear";
  console.error("Guide leftover cleanup failed, skipping ingest spend", { guideUrl, before, after });
  void logTraceEvent("ingest_cleanup_failed", `Leftover chunks remain for ${guideUrl}`, undefined, { guideUrl, before, after });
  return "blocked";
}

type GuideChunkMeta = {
  text: string;
  section_path: string[];
  section_confidence: number;
  chunk_index: number;
};

export async function insertGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  chunks: GuideChunkMeta[];
  embeddings: number[][];
  /** Model tag that produced `embeddings`; stored per row so queries use the same model. */
  model: string;
}): Promise<{ indexed: boolean; chunkCount: number; embedFailed?: boolean }> {
  const guideUrl = normalizeGuideUrl(input.guideUrl);
  if (!input.chunks.length) return { indexed: false, chunkCount: 0 };
  if (input.embeddings.length !== input.chunks.length) {
    console.error("Guide ingest embed count mismatch");
    return { indexed: false, chunkCount: 0 };
  }

  const rows = input.chunks.map((chunk, chunk_index) => ({
    guide_url: guideUrl,
    guide_bundle: null,
    chunk_index: chunk.chunk_index ?? chunk_index,
    chunk_text: chunk.text,
    section_path: chunk.section_path ?? [],
    section_confidence: chunk.section_confidence ?? null,
    embedding: toVectorString(input.embeddings[chunk_index]),
    embed_model: input.model,
  }));

  const insertStart = Date.now();
  let inserted = 0;
  let insertedFrom = rows.length; // lowest chunk_index this run has written
  try {
    // Write batches in REVERSE order so chunk 0 lands last and a partial write never
    // counts as indexed (guideIndexedIn). Leftovers were cleared before the embed spend.
    const lastOffset = Math.floor((rows.length - 1) / GUIDE_CHUNK_INSERT_BATCH) * GUIDE_CHUNK_INSERT_BATCH;
    for (let offset = lastOffset; offset >= 0; offset -= GUIDE_CHUNK_INSERT_BATCH) {
      const batch = rows.slice(offset, offset + GUIDE_CHUNK_INSERT_BATCH);
      let { error } = await input.supabase.from("guide_chunks").insert(batch);
      // db/embed-model-tag.sql not applied yet: Sumopod rows are the implicit default,
      // so store them untagged. Never store a non-Sumopod vector without its tag.
      if (error && /embed_model/.test(error.message) && input.model === SUMOPOD_MODEL_TAG) {
        ({ error } = await input.supabase
          .from("guide_chunks")
          .insert(batch.map(({ embed_model: _tag, ...row }) => row)));
      }
      if (error) {
        // Unique violation: another run owns this write. Never delete its rows.
        if (error.code === "23505") {
          const indexed = await guideIndexedIn(input.supabase, guideUrl);
          void logTraceEvent(
            "ingest_db_insert",
            `Concurrent ingest owns ${guideUrl}, indexed=${indexed}`,
            Date.now() - insertStart,
            { guideUrl, duplicate: true, indexed },
          );
          return { indexed, chunkCount: indexed ? input.chunks.length : 0, ...(indexed ? {} : { embedFailed: true }) };
        }
        // Other error: drop only the rows THIS run wrote.
        if (inserted > 0) {
          await deleteGuideChunks(input.supabase, guideUrl, insertedFrom);
        }
        void logTraceEvent(
          "ingest_db_insert",
          `Insert failed for ${guideUrl}: ${error.message}`,
          Date.now() - insertStart,
          {
            guideUrl,
            error: error.message,
            batchSize: batch.length,
            batchOffset: offset,
            insertedBeforeFailure: inserted,
          },
        );
        console.error("Guide ingest insert failed:", error);
        return { indexed: false, chunkCount: 0 };
      }
      inserted += batch.length;
      insertedFrom = offset;
    }
  } catch (error) {
    // Only this run's own range; a kill (no catch) is handled by isGuideIndexed + leftover cleanup.
    if (inserted > 0) await deleteGuideChunks(input.supabase, guideUrl, insertedFrom).catch(() => {});
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

const INGEST_HARD_KILL_MS = 300_000; // route maxDuration
const INGEST_EMBED_MARGIN_MS = 45_000; // room left for the DB inserts
const INGEST_EMBED_FLOOR_MS = 30_000;

/** min(280s, 300s - elapsed - 45s) via embed.ts; null when under the floor (skip the spend). */
function ingestEmbedTimeoutMs(startMs: number): number | null {
  const budget = INGEST_HARD_KILL_MS - (Date.now() - startMs) - INGEST_EMBED_MARGIN_MS;
  return budget < INGEST_EMBED_FLOOR_MS ? null : budget;
}

async function storeGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  text: string;
  signal?: AbortSignal;
  embedLog?: EmbedLogMeta;
  /** When this ingest started, to keep the embed inside the route's hard kill. */
  startMs: number;
  /** Replace a flagged (stale/insufficient) index: purge it only now, after the new embeds exist. */
  replace?: boolean;
}): Promise<{ indexed: boolean; chunkCount: number; embedFailed?: boolean; keptOld?: boolean }> {
  const chunks = chunkGuideWithMeta(input.text);
  if (!chunks.length) return { indexed: false, chunkCount: 0 };

  void logTraceEvent(
    "ingest_chunk",
    `Chunked guide into ${chunks.length} pieces for ${input.guideUrl}`,
    undefined,
    { guideUrl: input.guideUrl, chunkCount: chunks.length },
  );

  const embedTimeoutMs = ingestEmbedTimeoutMs(input.startMs);
  if (embedTimeoutMs === null) {
    void logTraceEvent("ingest_embed_error", `Not enough ingest time left to embed ${input.guideUrl}`, undefined, {
      guideUrl: input.guideUrl,
      error: true,
      reason: "budget",
    });
    return { indexed: false, chunkCount: 0, embedFailed: true };
  }

  const embedInputs = chunks.map((chunk) => `${formatEmbedPrefix(chunk)}${chunk.text}`);

  // One call = one model for the whole guide (Sumopod, else Qwen), never mixed.
  let embeddings: number[][];
  let model: string;
  try {
    ({ vectors: embeddings, model } = await embedTexts(embedInputs, input.signal, {
      purpose: "ingest",
      guideUrl: input.guideUrl,
      ...input.embedLog,
    }, { ingestTimeoutMs: embedTimeoutMs }));
  } catch (error) {
    void logTraceEvent(
      "ingest_embed_error",
      `Embedding failed for ${input.guideUrl}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { guideUrl: input.guideUrl, error: true },
    );
    console.error("Guide ingest embed failed:", error);
    return { indexed: false, chunkCount: 0, embedFailed: true };
  }

  if (input.replace) {
    const purged = await purgeGuideVerified(input.guideUrl);
    if (purged === "kept") return { indexed: false, chunkCount: 0, keptOld: true };
    if (purged === "unknown") return { indexed: false, chunkCount: 0, embedFailed: true };
  }

  return insertGuideChunks({
    supabase: chunkWriter(input.supabase),
    guideUrl: input.guideUrl,
    chunks,
    embeddings,
    model,
  });
}

function ingestGuidePage(
  rawUrl: string,
  _signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  // The shared flight must not carry the first caller's signal: a disconnect would fail every joiner.
  let key = rawUrl;
  try {
    key = parseGamefaqsFaqUrl(rawUrl) ? gamefaqsStorageUrl(rawUrl) : normalizeGuideUrl(rawUrl);
  } catch {}
  return singleFlight(key, () => runIngestGuidePage(rawUrl, undefined, ctx));
}

async function runIngestGuidePage(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  const supabase = getServerClient();
  if (!supabase || !isEmbedConfigured()) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  const guideUrl = parseGamefaqsFaqUrl(rawUrl)
    ? gamefaqsStorageUrl(rawUrl)
    : normalizeGuideUrl(rawUrl);

  // Replace-on-success: a flagged index is kept until the new embeds are ready (storeGuideChunks).
  let replace = false;
  if (await isGuideIndexed(guideUrl)) {
    const isGamefaqs = Boolean(parseGamefaqsFaqUrl(guideUrl));
    if (await guideNeedsOutlineReingest(supabase, guideUrl)) {
      void logTraceEvent(
        "ingest_stale_purge",
        `Replacing guide chunks missing outline metadata: ${guideUrl}`,
        undefined,
        { guideUrl, reason: "outline_metadata" },
      );
      replace = true;
    } else if (isGamefaqs) {
      // Purge only genuinely bad stored content (TOC-only / near-empty), not
      // merely-short guides — else a small real guide re-embeds every turn.
      const storedText = await guideChunkText(supabase, guideUrl);
      if (storedText === null) return indexedGuideCacheHit(supabase, guideUrl);
      if (gamefaqsExtractQuality(storedText).insufficient) {
        void logTraceEvent(
          "ingest_stale_purge",
          `Replacing insufficient GameFAQs chunks (${storedText.length} chars) for re-ingest: ${guideUrl}`,
          undefined,
          { guideUrl, totalChars: storedText.length },
        );
        replace = true;
      } else {
        return indexedGuideCacheHit(supabase, guideUrl);
      }
    } else {
      return indexedGuideCacheHit(supabase, guideUrl);
    }
  }

  // A failed re-extract of a flagged guide must leave the old index serving.
  // Only while chunk 0 still exists; if the purge already ran (or its recount failed) report paused.
  const bail = async (result: IngestResult): Promise<IngestResult> => {
    if (!replace) return result;
    if (await guideIndexedIn(supabase, guideUrl)) return indexedGuideCacheHit(supabase, guideUrl);
    return { ...result, embedFailed: true };
  };
  // No service key: the purge could never run, so extract + embed would be wasted every turn.
  if (replace && !getServiceClient()) return indexedGuideCacheHit(supabase, guideUrl);

  if (!replace) {
    const leftovers = await clearGuideLeftovers(getServiceClient(), supabase, guideUrl);
    if (leftovers === "cached") return indexedGuideCacheHit(supabase, guideUrl);
    if (leftovers === "blocked") {
      return { indexed: false, chunkCount: 0, hubWarning: false, embedFailed: true };
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
    return bail({ indexed: false, chunkCount: 0, hubWarning: looksLikeHub(guideUrl) });
  }
  if (isBlockedGuideContent(extracted.content)) {
    void logTraceEvent(
      "ingest_blocked",
      `GameFAQs anti-bot blocked extract for ${guideUrl}`,
      Date.now() - startMs,
      { guideUrl },
    );
    return bail({ indexed: false, chunkCount: 0, hubWarning: false, isBlocked: true });
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
      return bail({ indexed: false, chunkCount: 0, hubWarning: true });
    }
  }

  const hubWarning = looksLikeHub(guideUrl) || text.length < MIN_GUIDE_CHARS;
  const stored = await storeGuideChunks({
    supabase,
    guideUrl,
    text,
    signal,
    embedLog: embedLogFromContext(ctx),
    startMs,
    replace,
  });
  if (stored.keptOld) return indexedGuideCacheHit(supabase, guideUrl);
  if (!stored.indexed) {
    void logTraceEvent(
      "ingest_error",
      `Failed to store guide chunks for: ${guideUrl}`,
      Date.now() - startMs,
      { guideUrl, error: "Store failed" },
    );
    return bail({ indexed: false, chunkCount: 0, hubWarning: false, ...(stored.embedFailed ? { embedFailed: true } : {}) });
  }

  const title = await cacheGuideTitleFromExtract(supabase, guideUrl, extracted.content, signal);

  void logTraceEvent(
    "ingest_complete",
    `Successfully ingested guide: ${guideUrl}`,
    Date.now() - startMs,
    { guideUrl, chunkCount: stored.chunkCount, hubWarning, ...(title ? { title } : {}) },
  );
  return {
    indexed: true,
    chunkCount: stored.chunkCount,
    hubWarning,
    ...(title ? { title } : {}),
  };
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
    if (await isGuideIndexed(rawUrl)) {
      return indexedGuideCacheHit(supabase, rawUrl);
    }
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }
  return ingestGuidePage(rawUrl, signal, ctx);
}

/**
 * Ingest a guide from pre-extracted text (e.g. uploaded PDF/TXT/MD).
 * Skips Tavily extract — text is already available. Idempotent per guideUrl.
 */
export function ingestGuideFromText(input: {
  guideUrl: string;
  text: string;
  signal?: AbortSignal;
  ctx?: IngestContext;
}): Promise<IngestResult> {
  return singleFlight(input.guideUrl, () => runIngestGuideFromText({ ...input, signal: undefined }));
}

async function runIngestGuideFromText(input: {
  guideUrl: string;
  text: string;
  signal?: AbortSignal;
  ctx?: IngestContext;
}): Promise<IngestResult> {
  const supabase = getServerClient();
  if (!supabase || !isEmbedConfigured()) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  if (await isGuideIndexed(input.guideUrl)) {
    return indexedGuideCacheHit(supabase, input.guideUrl);
  }

  const leftovers = await clearGuideLeftovers(getServiceClient(), supabase, input.guideUrl);
  if (leftovers === "cached") return indexedGuideCacheHit(supabase, input.guideUrl);
  if (leftovers === "blocked") {
    return { indexed: false, chunkCount: 0, hubWarning: false, embedFailed: true };
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
    startMs,
  });

  if (!stored.indexed) {
    void logTraceEvent(
      "ingest_upload_error",
      `Failed to store uploaded guide: ${input.guideUrl}`,
      Date.now() - startMs,
      { guideUrl: input.guideUrl },
    );
    return { indexed: false, chunkCount: 0, hubWarning: false, ...(stored.embedFailed ? { embedFailed: true } : {}) };
  }

  const title = await cacheGuideTitleFromExtract(supabase, input.guideUrl, input.text);

  void logTraceEvent(
    "ingest_upload_complete",
    `Uploaded guide ingested: ${input.guideUrl}`,
    Date.now() - startMs,
    { guideUrl: input.guideUrl, chunkCount: stored.chunkCount, ...(title ? { title } : {}) },
  );
  return {
    indexed: true,
    chunkCount: stored.chunkCount,
    hubWarning: false,
    ...(title ? { title } : {}),
  };
}
