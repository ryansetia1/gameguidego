import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { chunkGuide } from "@/lib/chunk-guide.js";
import { embedTexts } from "@/lib/embed";
import type { EmbedLogMeta } from "@/lib/embed-log";
import { toVectorString } from "@/lib/embed-cache";
import { cleanSnippet } from "@/lib/clean.js";
import {
  parseGamefaqsFaqUrl,
  slugFromGamefaqsPageUrl,
  titleFromGamefaqsSlug,
  mergeGamefaqsBundlePages,
  parseGamefaqsGuideTitle,
  isGenericGamefaqsBundleTitle,
  pickGamefaqsBundleTitle,
} from "@/lib/gamefaqs-bundle.js";
import { discoverGamefaqsBundleResolved } from "@/lib/gamefaqs-discover";
import { isGamefaqsBundleUrl } from "@/lib/guide-urls.js";
import { getCachedBundleDiscovery, setCachedBundleDiscovery } from "@/lib/guide-bundle-cache.js";
import { parsePositiveInt, sleep } from "@/lib/replicate-retry.js";
import { extractGuidePage, extractGuidePages, looksLikeHub } from "@/lib/tavily";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const MIN_GUIDE_CHARS = 400;
// Bigger extract batches + shorter pauses for a funded account (retry backs off on
// throttle). Tune down via INGEST_EXTRACT_BATCH_SIZE / up via INGEST_BATCH_DELAY_MS
// if a low-balance Replicate account starts 429ing.
const EXTRACT_BATCH_SIZE = parsePositiveInt(process.env.INGEST_EXTRACT_BATCH_SIZE, 8, 10);
const INGEST_BATCH_DELAY_MS = parsePositiveInt(process.env.INGEST_BATCH_DELAY_MS, 300, 10_000);

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
  pagesMissing?: { slug: string; title: string; url: string }[];
  pagesSkipped?: number;
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

/** Remove pre-bundle single-page rows stored on the FAQ root URL. */
async function deleteOrphanBundleRootChunks(
  supabase: SupabaseClient,
  parsed: NonNullable<ReturnType<typeof parseGamefaqsFaqUrl>>,
): Promise<void> {
  const root = normalizeGuideUrl(parsed.canonicalUrl);
  try {
    await supabase
      .from("guide_chunks")
      .delete()
      .eq("guide_url", root)
      .is("guide_bundle", null);
  } catch (error) {
    console.error("Guide ingest orphan cleanup failed:", error);
  }
}

export type BundleIndexPageStatus = {
  slug: string;
  title: string;
  url: string;
  indexed: boolean;
  chunks: number;
};

export type BundleIndexStatus = {
  bundleKey: string;
  canonicalUrl: string;
  title: string;
  pageCount: number;
  discoveryPages: { slug: string; title: string; url: string }[];
  pagesIndexed: number;
  chunkCount: number;
  pages: BundleIndexPageStatus[];
};

/** Bundle panel state from Supabase only (guide_bundle_cache + guide_chunks). */
export async function getBundleIndexStatus(
  rawUrl: string,
): Promise<BundleIndexStatus | null> {
  const parsed = parseGamefaqsFaqUrl(rawUrl);
  const supabase = getClient();
  if (!parsed || !supabase) return null;

  try {
    const cached = await getCachedBundleDiscovery(parsed.bundleKey, { allowStale: true });

    const { data, error } = await supabase
      .from("guide_chunks")
      .select("guide_url")
      .eq("guide_bundle", parsed.bundleKey);
    if (error) return null;

    const byUrl = new Map<string, number>();
    for (const row of data ?? []) {
      if (!row?.guide_url) continue;
      byUrl.set(row.guide_url, (byUrl.get(row.guide_url) ?? 0) + 1);
    }

    const pages: BundleIndexPageStatus[] = [...byUrl.entries()]
      .map(([guideUrl, chunks]) => {
        const slug = slugFromGamefaqsPageUrl(guideUrl, parsed.faqId);
        return {
          slug,
          title: slug ? titleFromGamefaqsSlug(slug) : guideUrl,
          url: guideUrl,
          indexed: true,
          chunks,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    const discoveryPages = mergeGamefaqsBundlePages([
      ...(cached?.pages ?? []),
      ...pages.map((page) => ({
        slug: page.slug,
        title: page.title,
        url: page.url,
      })),
    ]);

    const chunkCount = pages.reduce((sum, page) => sum + page.chunks, 0);
    return {
      bundleKey: parsed.bundleKey,
      canonicalUrl: parsed.canonicalUrl,
      title: cached?.title ?? "GameFAQs guide",
      pageCount: discoveryPages.length,
      discoveryPages,
      pagesIndexed: pages.length,
      chunkCount,
      pages,
    };
  } catch {
    return null;
  }
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
      // Recount within the SAME bundle namespace, so a standalone null-bundle row
      // for this URL doesn't get mistaken for a successful bundle insert.
      const recount = input.supabase
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", guideUrl);
      const { count } = await (input.guideBundle
        ? recount.eq("guide_bundle", input.guideBundle)
        : recount.is("guide_bundle", null));
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
  embedLog?: EmbedLogMeta;
}): Promise<{ indexed: boolean; chunkCount: number }> {
  const chunks = chunkGuide(input.text);
  if (!chunks.length) return { indexed: false, chunkCount: 0 };

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks, input.signal, {
      purpose: "ingest",
      guideUrl: input.guideUrl,
      bundleKey: input.guideBundle ?? undefined,
      ...input.embedLog,
    });
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

type IngestContext = {
  game?: string;
  platform?: string;
  userId?: string | null;
  skipSlugs?: string[];
  includeSlugs?: string[];
};

function filterBundlePages<T extends { slug: string }>(
  pages: T[],
  ctx?: IngestContext,
): T[] {
  const skip = new Set((ctx?.skipSlugs ?? []).map((slug) => slug.toLowerCase()));
  const include = ctx?.includeSlugs?.length
    ? new Set(ctx.includeSlugs.map((slug) => slug.toLowerCase()))
    : null;
  return pages.filter((page) => {
    const slug = page.slug.toLowerCase();
    if (skip.has(slug)) return false;
    if (include && !include.has(slug)) return false;
    return true;
  });
}

function embedLogFromContext(ctx?: IngestContext): EmbedLogMeta | undefined {
  if (!ctx?.game && !ctx?.platform && !ctx?.userId) return undefined;
  return {
    purpose: "ingest",
    game: ctx.game,
    platform: ctx.platform,
    userId: ctx.userId,
  };
}

type PendingPage = {
  guideUrl: string;
  guideBundle: string | null;
  chunks: string[];
  slug: string;
};

async function storePendingPages(input: {
  supabase: SupabaseClient;
  pages: PendingPage[];
  signal?: AbortSignal;
  embedLog?: EmbedLogMeta;
}): Promise<{ pagesIndexed: number; chunkCount: number; indexedSlugs: string[] }> {
  if (!input.pages.length) return { pagesIndexed: 0, chunkCount: 0, indexedSlugs: [] };

  const flatChunks = input.pages.flatMap((page) => page.chunks);
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(flatChunks, input.signal, {
      purpose: "ingest",
      guideUrl: input.pages[0]?.guideUrl,
      bundleKey: input.pages[0]?.guideBundle ?? undefined,
      ...input.embedLog,
    });
  } catch (error) {
    // One 429/abort must not drop the whole batch (up to EXTRACT_BATCH_SIZE pages).
    // Fall back to embedding + storing each page on its own, best-effort per page.
    console.error("Guide ingest batch embed failed, retrying per page:", error);
    let pagesIndexed = 0;
    let chunkCount = 0;
    const indexedSlugs: string[] = [];
    for (const page of input.pages) {
      try {
        const pageEmbeddings = await embedTexts(page.chunks, input.signal, {
          purpose: "ingest",
          guideUrl: page.guideUrl,
          bundleKey: page.guideBundle ?? undefined,
          ...input.embedLog,
        });
        const stored = await insertGuideChunks({
          supabase: input.supabase,
          guideUrl: page.guideUrl,
          guideBundle: page.guideBundle,
          chunks: page.chunks,
          embeddings: pageEmbeddings,
        });
        if (stored.indexed) {
          pagesIndexed += 1;
          chunkCount += stored.chunkCount;
          indexedSlugs.push(page.slug);
        }
      } catch (pageError) {
        console.error("Guide ingest per-page embed failed:", pageError);
      }
    }
    return { pagesIndexed, chunkCount, indexedSlugs };
  }

  let pagesIndexed = 0;
  let chunkCount = 0;
  let offset = 0;
  const indexedSlugs: string[] = [];

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
      indexedSlugs.push(page.slug);
    }
  }

  return { pagesIndexed, chunkCount, indexedSlugs };
}

async function ingestSingleGuidePage(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
  bundleKey: string | null = null,
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
    guideBundle: bundleKey,
    text,
    signal,
    embedLog: embedLogFromContext(ctx),
  });
  if (!stored.indexed) {
    return { indexed: false, chunkCount: 0, hubWarning: true };
  }
  return { indexed: true, chunkCount: stored.chunkCount, hubWarning };
}

async function ingestGamefaqsBundle(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  const supabase = getClient();
  if (!supabase || !process.env.REPLICATE_API_TOKEN) {
    return { indexed: false, chunkCount: 0, hubWarning: false };
  }

  const parsed = parseGamefaqsFaqUrl(rawUrl);
  if (!parsed) {
    return ingestSingleGuidePage(rawUrl, signal, ctx);
  }

  const discoveryCached = await discoverGamefaqsBundleResolved(rawUrl, signal, {
    refresh: false,
  });
  // ponytail: never full refresh on ingest — manual "Refresh page list" only.
  // Cache-first + light search is enough; full part-query discovery burns 100+ Tavily calls.
  const discovery = discoveryCached;
  if (!discovery.bundle || !discovery.pages?.length) {
    return ingestSingleGuidePage(rawUrl, signal, ctx, parsed.bundleKey);
  }

  const targetPages = filterBundlePages(discovery.pages, ctx);
  if (!targetPages.length) {
    return {
      indexed: false,
      chunkCount: 0,
      hubWarning: true,
      bundle: true,
      bundleKey: parsed.bundleKey,
      pageCount: 0,
      pagesIndexed: 0,
      pagesSkipped: discovery.pages.length,
    };
  }

  const pageCount = targetPages.length;
  const bundleKey = parsed.bundleKey;
  const skippedCount = discovery.pages.length - targetPages.length;

  await deleteOrphanBundleRootChunks(supabase, parsed);

  let pagesIndexed = 0;
  let chunkCount = 0;
  const indexedSlugs = new Set<string>();
  let resolvedTitle = discovery.title ?? "GameFAQs guide";

  async function processBatch(batch: typeof targetPages, background: boolean) {
    const activeSignal = background ? undefined : signal;
    const extracted = await extractGuidePages(
      batch.map((page) => page.url),
      activeSignal,
    );

    const pending: PendingPage[] = [];
    for (const page of batch) {
      let content = extracted.get(page.url) ?? extracted.get(normalizeGuideUrl(page.url));
      if (!content) {
        const solo = await extractGuidePage(page.url, activeSignal);
        content = solo?.content;
      }
      const normalized = normalizeGuideUrl(page.url);
      const { count: dbCountBefore } = await (supabase as SupabaseClient)
        .from("guide_chunks")
        .select("*", { count: "exact", head: true })
        .eq("guide_url", normalized)
        .eq("guide_bundle", bundleKey);
      const chunksPreview = content ? chunkGuide(content) : [];
      if (!content) continue;

      if (
        isGenericGamefaqsBundleTitle(resolvedTitle) &&
        (page.slug === "introduction" || page.slug === "walkthrough")
      ) {
        const parsedTitle = parseGamefaqsGuideTitle(content, parsed as NonNullable<ReturnType<typeof parseGamefaqsFaqUrl>>);
        if (!isGenericGamefaqsBundleTitle(parsedTitle)) resolvedTitle = parsedTitle;
      }

      if ((dbCountBefore ?? 0) > 0) {
        pagesIndexed += 1;
        chunkCount += dbCountBefore ?? 0;
        indexedSlugs.add(page.slug);
        continue;
      }

      const chunks = chunksPreview;
      if (!chunks.length) continue;
      pending.push({
        guideUrl: page.url,
        guideBundle: bundleKey,
        chunks,
        slug: page.slug,
      });
    }

    const stored = await storePendingPages({
      supabase: supabase as SupabaseClient,
      pages: pending,
      signal: activeSignal,
      embedLog: embedLogFromContext(ctx),
    });
    pagesIndexed += stored.pagesIndexed;
    chunkCount += stored.chunkCount;
    for (const slug of stored.indexedSlugs) indexedSlugs.add(slug);
  }

  // 1. Process FIRST batch synchronously (Fast initial response)
  const firstBatch = targetPages.slice(0, EXTRACT_BATCH_SIZE);
  await processBatch(firstBatch, false);

  // 2. Bookkeeping: Save the TOC so UI knows what's still missing.
  void setCachedBundleDiscovery(bundleKey, {
    canonicalUrl: parsed.canonicalUrl,
    title: pickGamefaqsBundleTitle(resolvedTitle, discovery.title),
    pages: discovery.pages,
  });

  const pagesMissing = targetPages
    .filter((page) => !indexedSlugs.has(page.slug))
    .map((page) => ({ slug: page.slug, title: page.title, url: page.url }));

  // 3. Process remaining batches in the background
  if (targetPages.length > EXTRACT_BATCH_SIZE) {
    after(async () => {
      for (let offset = EXTRACT_BATCH_SIZE; offset < targetPages.length; offset += EXTRACT_BATCH_SIZE) {
        if (INGEST_BATCH_DELAY_MS) {
          await sleep(INGEST_BATCH_DELAY_MS); // No signal, let background task wait naturally
        }
        const batch = targetPages.slice(offset, offset + EXTRACT_BATCH_SIZE);
        await processBatch(batch, true);
      }
    });
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
    pagesMissing: pagesMissing.length ? pagesMissing : undefined,
    pagesSkipped: skippedCount > 0 ? skippedCount : undefined,
  };
}

/**
 * Fetch, chunk, embed, and store a preferred guide page or multi-page bundle.
 * Idempotent per URL / bundle. Best-effort when Supabase/Tavily/embed is unavailable.
 */
export async function ensureGuideIngested(
  rawUrl: string,
  signal?: AbortSignal,
  ctx?: IngestContext,
): Promise<IngestResult> {
  if (parseGamefaqsFaqUrl(rawUrl)) {
    return ingestGamefaqsBundle(rawUrl, signal, ctx);
  }
  return ingestSingleGuidePage(rawUrl, signal, ctx);
}
