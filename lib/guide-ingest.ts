import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { chunkGuide } from "@/lib/chunk-guide.js";
import { embedTexts } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import { cleanSnippet } from "@/lib/clean.js";
import {
  discoverGamefaqsBundle,
  parseGamefaqsFaqUrl,
} from "@/lib/gamefaqs-bundle.js";
import { isGamefaqsBundleUrl } from "@/lib/guide-urls.js";
import { parsePositiveInt, sleep } from "@/lib/replicate-retry.js";
import { extractGuidePage, extractGuidePages, looksLikeHub } from "@/lib/tavily";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const MIN_GUIDE_CHARS = 400;
// Smaller Tavily batches + pauses keep low-balance Replicate accounts from throttling.
const EXTRACT_BATCH_SIZE = parsePositiveInt(process.env.INGEST_EXTRACT_BATCH_SIZE, 5, 10);
const INGEST_BATCH_DELAY_MS = parsePositiveInt(process.env.INGEST_BATCH_DELAY_MS, 800, 10_000);

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
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
  return Boolean(url && anonKey && process.env.REPLICATE_API_TOKEN);
}

export type IngestResult = {
  indexed: boolean;
  chunkCount: number;
  hubWarning: boolean;
  bundle?: boolean;
  bundleKey?: string;
  pageCount?: number;
  pagesIndexed?: number;
};

async function countBundleChunks(
  supabase: SupabaseClient,
  bundleKey: string,
): Promise<number> {
  const { count } = await supabase
    .from("guide_chunks")
    .select("*", { count: "exact", head: true })
    .eq("guide_bundle", bundleKey);
  return count ?? 0;
}

/** True when guide_chunks already has rows for this URL or bundle. */
export async function isGuideIndexed(guideUrl: string): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  try {
    const parsed = parseGamefaqsFaqUrl(guideUrl);
    if (parsed && isGamefaqsBundleUrl(guideUrl)) {
      return (await countBundleChunks(supabase, parsed.bundleKey)) > 0;
    }
    const normalized = normalizeGuideUrl(guideUrl);
    const { count, error } = await supabase
      .from("guide_chunks")
      .select("*", { count: "exact", head: true })
      .eq("guide_url", normalized);
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function insertGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  guideBundle: string | null;
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
    guide_bundle: input.guideBundle,
    chunk_index,
    chunk_text,
    embedding: toVectorString(input.embeddings[chunk_index]),
  }));

  try {
    const { error } = await input.supabase.from("guide_chunks").insert(rows);
    if (error) {
      const { count } = await input.supabase
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", guideUrl);
      if ((count ?? 0) > 0) {
        return { indexed: true, chunkCount: count ?? input.chunks.length };
      }
      console.error("Guide ingest insert failed:", error);
      return { indexed: false, chunkCount: 0 };
    }
  } catch (error) {
    console.error("Guide ingest insert failed:", error);
    return { indexed: false, chunkCount: 0 };
  }

  return { indexed: true, chunkCount: input.chunks.length };
}

async function storeGuideChunks(input: {
  supabase: SupabaseClient;
  guideUrl: string;
  guideBundle: string | null;
  text: string;
  signal?: AbortSignal;
}): Promise<{ indexed: boolean; chunkCount: number }> {
  const chunks = chunkGuide(input.text);
  if (!chunks.length) return { indexed: false, chunkCount: 0 };

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks, input.signal);
  } catch (error) {
    console.error("Guide ingest embed failed:", error);
    return { indexed: false, chunkCount: 0 };
  }

  return insertGuideChunks({
    supabase: input.supabase,
    guideUrl: input.guideUrl,
    guideBundle: input.guideBundle,
    chunks,
    embeddings,
  });
}

type PendingPage = {
  guideUrl: string;
  guideBundle: string | null;
  chunks: string[];
};

async function storePendingPages(input: {
  supabase: SupabaseClient;
  pages: PendingPage[];
  signal?: AbortSignal;
}): Promise<{ pagesIndexed: number; chunkCount: number }> {
  if (!input.pages.length) return { pagesIndexed: 0, chunkCount: 0 };

  const flatChunks = input.pages.flatMap((page) => page.chunks);
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(flatChunks, input.signal);
  } catch (error) {
    console.error("Guide ingest batch embed failed:", error);
    return { pagesIndexed: 0, chunkCount: 0 };
  }

  let pagesIndexed = 0;
  let chunkCount = 0;
  let offset = 0;

  for (const page of input.pages) {
    const slice = embeddings.slice(offset, offset + page.chunks.length);
    offset += page.chunks.length;
    const stored = await insertGuideChunks({
      supabase: input.supabase,
      guideUrl: page.guideUrl,
      guideBundle: page.guideBundle,
      chunks: page.chunks,
      embeddings: slice,
    });
    if (stored.indexed) {
      pagesIndexed += 1;
      chunkCount += stored.chunkCount;
    }
  }

  return { pagesIndexed, chunkCount };
}

async function ingestSingleGuidePage(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const supabase = getClient();
  if (!supabase || !process.env.REPLICATE_API_TOKEN) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  const guideUrl = normalizeGuideUrl(rawUrl);

  if (await isGuideIndexed(guideUrl)) {
    const { count } = await supabase
      .from("guide_chunks")
      .select("*", { count: "exact", head: true })
      .eq("guide_url", guideUrl);
    return { indexed: true, chunkCount: count ?? 0, hubWarning: false };
  }

  const extracted = await extractGuidePage(guideUrl, signal);
  if (!extracted) {
    console.error("Guide ingest skipped: could not extract guide page", { guideUrl });
    return { indexed: false, chunkCount: 0, hubWarning: looksLikeHub(guideUrl) };
  }

  const text = cleanSnippet(extracted.content);
  const hubWarning = looksLikeHub(guideUrl) || text.length < MIN_GUIDE_CHARS;
  const stored = await storeGuideChunks({
    supabase,
    guideUrl,
    guideBundle: null,
    text,
    signal,
  });
  if (!stored.indexed) {
    return { indexed: false, chunkCount: 0, hubWarning: true };
  }
  return { indexed: true, chunkCount: stored.chunkCount, hubWarning };
}

async function ingestGamefaqsBundle(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  const supabase = getClient();
  if (!supabase || !process.env.REPLICATE_API_TOKEN) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  const parsed = parseGamefaqsFaqUrl(rawUrl);
  if (!parsed) {
    return ingestSingleGuidePage(rawUrl, signal);
  }

  const discovery = await discoverGamefaqsBundle(rawUrl, signal);
  if (!discovery.bundle || !discovery.pages?.length) {
    return ingestSingleGuidePage(rawUrl, signal);
  }

  const { pageCount = discovery.pages.length } = discovery;
  const bundleKey = parsed.bundleKey;
  const existingChunks = await countBundleChunks(supabase, bundleKey);
  if (existingChunks > 0) {
    return {
      indexed: true,
      chunkCount: existingChunks,
      hubWarning: false,
      bundle: true,
      bundleKey,
      pageCount,
      pagesIndexed: pageCount,
    };
  }

  let pagesIndexed = 0;
  let chunkCount = 0;

  for (let offset = 0; offset < discovery.pages.length; offset += EXTRACT_BATCH_SIZE) {
    const batch = discovery.pages.slice(offset, offset + EXTRACT_BATCH_SIZE);
    const extracted = await extractGuidePages(
      batch.map((page) => page.url),
      signal,
    );

    const pending: PendingPage[] = [];
    for (const page of batch) {
      const content = extracted.get(page.url) ?? extracted.get(normalizeGuideUrl(page.url));
      if (!content) continue;

      const normalized = normalizeGuideUrl(page.url);
      const { count } = await supabase
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", normalized);
      if ((count ?? 0) > 0) {
        pagesIndexed += 1;
        chunkCount += count ?? 0;
        continue;
      }

      const chunks = chunkGuide(content);
      if (!chunks.length) continue;
      pending.push({
        guideUrl: page.url,
        guideBundle: bundleKey,
        chunks,
      });
    }

    const stored = await storePendingPages({ supabase, pages: pending, signal });
    pagesIndexed += stored.pagesIndexed;
    chunkCount += stored.chunkCount;

    const hasMore = offset + EXTRACT_BATCH_SIZE < discovery.pages.length;
    if (hasMore && INGEST_BATCH_DELAY_MS) {
      await sleep(INGEST_BATCH_DELAY_MS, signal);
    }
  }

  const hubWarning = pagesIndexed === 0;
  return {
    indexed: pagesIndexed > 0,
    chunkCount,
    hubWarning,
    bundle: true,
    bundleKey,
    pageCount,
    pagesIndexed,
  };
}

/**
 * Fetch, chunk, embed, and store a preferred guide page or multi-page bundle.
 * Idempotent per URL / bundle. Best-effort when Supabase/Tavily/embed is unavailable.
 */
export async function ensureGuideIngested(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<IngestResult> {
  if (parseGamefaqsFaqUrl(rawUrl)) {
    return ingestGamefaqsBundle(rawUrl, signal);
  }
  return ingestSingleGuidePage(rawUrl, signal);
}
