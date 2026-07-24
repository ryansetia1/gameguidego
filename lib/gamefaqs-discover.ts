import {
  buildGamefaqsDiscoveryBaseQueries,
  buildGamefaqsPartDiscoveryQueries,
  discoverGamefaqsBundle,
  isGenericGamefaqsBundleTitle,
  isLikelySinglePageGamefaqsGuide,
  mergeGamefaqsBundlePages,
  parseGamefaqsFaqUrl,
  parseGamefaqsGuideTitle,
  parseGamefaqsPagesFromUrls,
  parseGamefaqsTocFromHtml,
  pickGamefaqsBundleTitle,
} from "@/lib/gamefaqs-bundle.js";
import {
  getCachedBundleDiscovery,
  getIndexedBundlePagesFromDb,
  setCachedBundleDiscovery,
} from "@/lib/guide-bundle-cache.js";
import { extractGuidePage, searchDiscoveryUrls, isBlockedGuideContent } from "@/lib/tavily";
import { logTraceEvent } from "@/lib/trace";

type BundleDiscovery = Awaited<ReturnType<typeof discoverGamefaqsBundle>> & { isBlocked?: boolean };
type ParsedFaq = NonNullable<ReturnType<typeof parseGamefaqsFaqUrl>>;
type BundlePage = { title: string; url: string; slug: string };

export type DiscoverOptions = { refresh?: boolean };

const PART_QUERY_PAGE_THRESHOLD = 50;

function buildBundleDiscovery(
  parsed: ParsedFaq,
  pages: BundlePage[],
  title = "GameFAQs guide",
): BundleDiscovery {
  return {
    bundle: true,
    provider: "gamefaqs",
    bundleKey: parsed.bundleKey,
    canonicalUrl: parsed.canonicalUrl,
    title,
    pageCount: pages.length,
    pages,
  };
}

async function enrichGamefaqsBundleTitle(
  parsed: ParsedFaq,
  signal?: AbortSignal,
): Promise<string> {
  const candidates = [
    `${parsed.canonicalUrl}/introduction`,
    `${parsed.canonicalUrl}/walkthrough`,
    parsed.canonicalUrl,
  ];

  for (const url of candidates) {
    const extracted = await extractGuidePage(url, signal, true);
    if (!extracted?.content || isBlockedGuideContent(extracted.content)) continue;
    const title = parseGamefaqsGuideTitle(extracted.content, parsed);
    if (!isGenericGamefaqsBundleTitle(title)) return title;
  }

  return "";
}

async function resolveDiscoveryTitle(
  parsed: ParsedFaq,
  title: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isGenericGamefaqsBundleTitle(title)) return title;
  const enriched = await enrichGamefaqsBundleTitle(parsed, signal);
  return isGenericGamefaqsBundleTitle(enriched) ? title : enriched;
}

async function enrichBundlePagesFromExtracts(
  parsed: ParsedFaq,
  seedPages: BundlePage[],
  signal?: AbortSignal,
): Promise<BundlePage[]> {
  const merged = [...seedPages];
  const seeds = seedPages.filter(
    (page) =>
      page.slug === "walkthrough" ||
      page.slug === "introduction" ||
      page.slug.startsWith("part-1") ||
      page.slug === "frequently-asked-questions",
  );

  for (const page of seeds.slice(0, 6)) {
    const extracted = await extractGuidePage(page.url, signal, true);
    if (!extracted?.content || isBlockedGuideContent(extracted.content)) continue;
    const found = parseGamefaqsTocFromHtml(extracted.content, parsed);
    if (found.length) merged.push(...found);
  }

  return mergeGamefaqsBundlePages(merged);
}

type SearchDiscoverOptions = {
  partQueries?: boolean;
  enrich?: boolean;
  /** Stop after this many unique bundle pages (0 = run all queries). */
  earlyExitMinPages?: number;
};

async function runDiscoveryQueries(
  parsed: ParsedFaq,
  queries: string[],
  seedPages: BundlePage[],
  signal?: AbortSignal,
  earlyExitMinPages = 0,
): Promise<BundlePage[]> {
  const seenUrls = new Set<string>();
  let pages = mergeGamefaqsBundlePages(seedPages);

  for (const query of queries) {
    let hits = [];
    try {
      void logTraceEvent("discovery_search_query", `Running Tavily search query: ${query}`);
      hits = await searchDiscoveryUrls(query, signal, {
        domains: ["gamefaqs.gamespot.com"],
        maxResults: 30,
      });
    } catch {
      continue;
    }

    const batchUrls: string[] = [];
    for (const hit of hits) {
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);
      batchUrls.push(hit.url);
    }
    if (!batchUrls.length) continue;

    pages = mergeGamefaqsBundlePages([
      ...pages,
      ...parseGamefaqsPagesFromUrls(batchUrls, parsed),
    ]);
    if (earlyExitMinPages > 0 && pages.length >= earlyExitMinPages) {
      return pages;
    }
  }

  return pages;
}

async function discoverGamefaqsBundleViaSearch(
  parsed: ParsedFaq,
  signal?: AbortSignal,
  seedPages: BundlePage[] = [],
  options: SearchDiscoverOptions = {},
): Promise<BundlePage[]> {
  const partQueries = options.partQueries ?? true;
  const enrich = options.enrich ?? true;
  const earlyExitMinPages = options.earlyExitMinPages ?? 0;

  let pages = mergeGamefaqsBundlePages(seedPages);

  pages = await runDiscoveryQueries(
    parsed,
    buildGamefaqsDiscoveryBaseQueries(parsed),
    pages,
    signal,
    earlyExitMinPages,
  );
  if (earlyExitMinPages > 0 && pages.length >= earlyExitMinPages) {
    return pages;
  }

  if (partQueries && pages.length < PART_QUERY_PAGE_THRESHOLD) {
    pages = await runDiscoveryQueries(
      parsed,
      buildGamefaqsPartDiscoveryQueries(parsed),
      pages,
      signal,
      earlyExitMinPages,
    );
    if (earlyExitMinPages > 0 && pages.length >= earlyExitMinPages) {
      return pages;
    }
  }

  if (pages.length <= 1) return pages;
  if (!enrich) return pages;
  return enrichBundlePagesFromExtracts(parsed, pages, signal);
}

function buildExtractCandidates(parsed: ParsedFaq, rawUrl: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  const hinted = parseGamefaqsFaqUrl(rawUrl);
  const intro = `${parsed.canonicalUrl}/introduction`;
  const walkthrough = `${parsed.canonicalUrl}/walkthrough`;
  const root = parsed.canonicalUrl;

  if (hinted?.sectionSlug) {
    add(rawUrl);
    add(root);
    add(intro);
    add(walkthrough);
    return out;
  }

  // Bundle-root paste: try the FAQ root first — one extract often yields either
  // a multi-page TOC or the full single-page guide text.
  add(root);
  add(intro);
  add(walkthrough);
  return out;
}

async function cacheSinglePageDiscovery(parsed: ParsedFaq, title: string): Promise<void> {
  void setCachedBundleDiscovery(parsed.bundleKey, {
    canonicalUrl: parsed.canonicalUrl,
    title,
    pages: [],
    singlePage: true,
    isBlocked: false,
  });
}

async function discoverGamefaqsBundleViaExtract(
  parsed: ParsedFaq,
  rawUrl: string,
  seedPages: BundlePage[],
  signal?: AbortSignal,
): Promise<{ pages: BundlePage[]; title: string; definiteSinglePage?: boolean; isBlocked?: boolean }> {
  let bestTitle = "GameFAQs guide";
  let isBlocked = false;

  for (const url of buildExtractCandidates(parsed, rawUrl)) {
    void logTraceEvent("discovery_extract_start", `Attempting Tavily extract on ${url}`);
    const extracted = await extractGuidePage(url, signal, true);
    if (!extracted?.content) {
      void logTraceEvent("discovery_extract_empty", `Tavily extract returned no content for ${url}`);
      continue;
    }
    if (isBlockedGuideContent(extracted.content)) {
      void logTraceEvent("discovery_extract_blocked", `GameFAQs Cloudflare block detected on ${url}`);
      isBlocked = true;
      break;
    }

    const title = parseGamefaqsGuideTitle(extracted.content, parsed);
    if (!isGenericGamefaqsBundleTitle(title)) bestTitle = title;

    const fromToc = parseGamefaqsTocFromHtml(extracted.content, parsed);
    const merged = mergeGamefaqsBundlePages([...seedPages, ...fromToc]);

    if (merged.length > 1) {
      void logTraceEvent("discovery_extract_success", `Found ${merged.length} pages via TOC on ${url}`);
      return {
        pages: merged,
        title: bestTitle,
      };
    }

    if (url === parsed.canonicalUrl && isLikelySinglePageGamefaqsGuide(extracted.content, parsed)) {
      void logTraceEvent(
        "discovery_single_page",
        `Detected single-page GameFAQs FAQ at ${url}`,
        undefined,
        { bundleKey: parsed.bundleKey, chars: extracted.content.length },
      );
      return { pages: seedPages, title: bestTitle, definiteSinglePage: true };
    }

    void logTraceEvent("discovery_extract_single", `Extracted ${url} but found no multi-page TOC`);
  }

  return { pages: seedPages, title: bestTitle, isBlocked };
}

async function discoverViaTavily(
  parsed: ParsedFaq,
  signal?: AbortSignal,
  seedPages: BundlePage[] = [],
): Promise<{ pages: BundlePage[]; title: string; isBlocked?: boolean }> {
  const fromExtract = await discoverGamefaqsBundleViaExtract(parsed, parsed.canonicalUrl, seedPages, signal);
  if (fromExtract.pages.length > 1) {
    const enriched = await enrichBundlePagesFromExtracts(parsed, fromExtract.pages, signal);
    return { pages: enriched, title: fromExtract.title };
  }

  if (fromExtract.definiteSinglePage || fromExtract.isBlocked) {
    if (fromExtract.definiteSinglePage && !fromExtract.isBlocked) {
      await cacheSinglePageDiscovery(parsed, fromExtract.title);
    }
    return { pages: seedPages, title: fromExtract.title, isBlocked: fromExtract.isBlocked };
  }

  // Extract failed to yield a TOC and we couldn't prove it's a single page — bounded site-search fallback.
  // the Tavily fan-out (was up to ~58 advanced calls on a cold refresh).
  const fromSearch = await discoverGamefaqsBundleViaSearch(parsed, signal, seedPages, {
    earlyExitMinPages: 15,
  });
  return { pages: fromSearch, title: "GameFAQs guide" };
}

async function mergeAndCacheDiscovery(
  parsed: ParsedFaq,
  discovered: BundlePage[],
  title: string,
): Promise<BundlePage[]> {
  const cached = await getCachedBundleDiscovery(parsed.bundleKey, { allowStale: true });
  const fromDb = await getIndexedBundlePagesFromDb(parsed.bundleKey);
  const merged = mergeGamefaqsBundlePages([
    ...discovered,
    ...(cached?.pages ?? []),
    ...fromDb,
  ]);

  if (merged.length > 1) {
    void setCachedBundleDiscovery(parsed.bundleKey, {
      canonicalUrl: parsed.canonicalUrl,
      title: pickGamefaqsBundleTitle(title, cached?.title),
      pages: merged,
    });
  }

  return merged;
}

async function discoverFromCacheAndDb(
  parsed: ParsedFaq,
) {
  const cached = await getCachedBundleDiscovery(parsed.bundleKey, { allowStale: true });
  const fromDb = await getIndexedBundlePagesFromDb(parsed.bundleKey);
  const pages = mergeGamefaqsBundlePages([...(cached?.pages ?? []), ...fromDb]);
  return { pages, title: cached?.title ?? "GameFAQs guide", cached };
}

async function discoverGamefaqsBundleCacheFirst(
  parsed: ParsedFaq,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<BundleDiscovery> {
  const { pages: seedPages, title, cached } = await discoverFromCacheAndDb(parsed);
  if (cached) {
    if (cached.isBlocked) {
      void logTraceEvent("discovery_cache_hit_blocked", `Blocked discovery cache hit for ${parsed.bundleKey}`);
      return { bundle: false, isBlocked: true };
    }
    if (cached.singlePage) {
      void logTraceEvent(
        "discovery_cache_hit_single",
        `Single-page discovery cache hit for ${parsed.bundleKey}`,
        undefined,
        { bundleKey: parsed.bundleKey },
      );
      return { bundle: false };
    }
    if (seedPages.length > 1) {
      void logTraceEvent("discovery_cache_hit", `Discovery cache hit: ${seedPages.length} pages for ${parsed.bundleKey}`, undefined, { bundleKey: parsed.bundleKey, pageCount: seedPages.length });
      return buildBundleDiscovery(parsed, seedPages, title);
    }
  }

  void logTraceEvent("discovery_cache_miss", `Discovery cache miss for ${parsed.bundleKey}, running Tavily discovery`, undefined, { bundleKey: parsed.bundleKey, seedPageCount: seedPages.length });

  // ponytail: dropped the direct GameFAQs fetch — it's Cloudflare-blocked (see
  // header note), so it only cost a guaranteed-failing round-trip on every
  // discovery. The Tavily extract below reads the same TOC without the block.
  const extracted = await discoverGamefaqsBundleViaExtract(parsed, rawUrl, seedPages, signal);
  if (extracted.pages.length > 1) {
    const merged = await mergeAndCacheDiscovery(parsed, extracted.pages, extracted.title);
    if (merged.length > 1) {
      return buildBundleDiscovery(parsed, merged, extracted.title);
    }
  }

  if (extracted.definiteSinglePage || extracted.isBlocked) {
    if (extracted.definiteSinglePage && !extracted.isBlocked) {
      await cacheSinglePageDiscovery(parsed, extracted.title);
    }
    if (seedPages.length > 0) {
      return buildBundleDiscovery(parsed, seedPages, title);
    }
    if (extracted.isBlocked) {
      void setCachedBundleDiscovery(parsed.bundleKey, { isBlocked: true });
    }
    return { bundle: false, isBlocked: extracted.isBlocked };
  }

  // Extract failed to yield a TOC — run all base site-search queries (no early
  // exit at 2) so we don't cache a truncated 2-page list as the complete bundle,
  // which would freeze until a manual refresh.
  const fromSearch = await discoverGamefaqsBundleViaSearch(parsed, signal, seedPages, {
    partQueries: false,
    enrich: false,
    earlyExitMinPages: 0,
  });
  if (fromSearch.length > 1) {
    const searchTitle = await resolveDiscoveryTitle(parsed, extracted.title, signal);
    const merged = await mergeAndCacheDiscovery(parsed, fromSearch, searchTitle);
    if (merged.length > 1) {
      return buildBundleDiscovery(parsed, merged, searchTitle);
    }
  }

  if (seedPages.length > 0) {
    return buildBundleDiscovery(parsed, seedPages, title);
  }

  return { bundle: false };
}

async function discoverGamefaqsBundleFull(
  parsed: ParsedFaq,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<BundleDiscovery> {
  const cached = await getCachedBundleDiscovery(parsed.bundleKey);
  const bundleKey = parsed.bundleKey;
  const seedPages = mergeGamefaqsBundlePages([
    ...(cached?.pages ?? []),
    ...(await getIndexedBundlePagesFromDb(parsed.bundleKey)),
  ]);

  // ponytail: dropped the Cloudflare-blocked direct fetch here too.
  const fresh = await discoverViaTavily(parsed, signal, seedPages);
  if (fresh.isBlocked) {
    void logTraceEvent(
      "ingest_bundle_blocked",
      `GameFAQs anti-bot blocked bundle discovery for ${parsed.canonicalUrl}`,
      undefined,
      { bundleKey },
    );
    // Cache the failure so we don't spam Tavily/GameFAQs within the TTL
    void setCachedBundleDiscovery(bundleKey, { isBlocked: true });
    return { bundle: false, isBlocked: true };
  }

  const resolvedTitle = await resolveDiscoveryTitle(parsed, fresh.title, signal);
  const merged = await mergeAndCacheDiscovery(parsed, fresh.pages, resolvedTitle);

  if (merged.length > 1) {
    return buildBundleDiscovery(
      parsed,
      merged,
      pickGamefaqsBundleTitle(resolvedTitle, cached?.title),
    );
  }

  if (seedPages.length > 1) {
    const seedTitle = await resolveDiscoveryTitle(
      parsed,
      cached?.title ?? fresh.title ?? "GameFAQs guide",
      signal,
    );
    return buildBundleDiscovery(
      parsed,
      seedPages,
      pickGamefaqsBundleTitle(seedTitle, cached?.title),
    );
  }

  return { bundle: false };
}

/**
 * GameFAQs blocks direct HTML fetch (Cloudflare). Fall back to Tavily extract,
 * site search (+ per-part queries when sparse), merge with Supabase TOC cache
 * and any pages already indexed in guide_chunks.
 *
 * Default (`refresh: false`) reads cache + DB, then Tavily extract and a
 * lightweight site search when the TOC is still sparse. Pass `refresh: true`
 * for a full Tavily discovery pass (manual refresh).
 */
export async function discoverGamefaqsBundleResolved(
  rawUrl: string,
  signal?: AbortSignal,
  options: DiscoverOptions = {},
): Promise<BundleDiscovery> {
  const parsed = parseGamefaqsFaqUrl(rawUrl);
  if (!parsed) return discoverGamefaqsBundle(rawUrl, signal);

  if (!options.refresh) {
    return discoverGamefaqsBundleCacheFirst(parsed, rawUrl, signal);
  }

  return discoverGamefaqsBundleFull(parsed, rawUrl, signal);
}
