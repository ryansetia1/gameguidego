import {
  buildGamefaqsDiscoveryBaseQueries,
  buildGamefaqsPartDiscoveryQueries,
  discoverGamefaqsBundle,
  isGenericGamefaqsBundleTitle,
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
import { extractGuidePage, searchDiscoveryUrls } from "@/lib/tavily";

type BundleDiscovery = Awaited<ReturnType<typeof discoverGamefaqsBundle>>;
type ParsedFaq = NonNullable<ReturnType<typeof parseGamefaqsFaqUrl>>;
type BundlePage = { title: string; url: string; slug: string };

export type DiscoverOptions = { refresh?: boolean };

const PART_QUERY_PAGE_THRESHOLD = 12;

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

function isBlockedGuideContent(text: string): boolean {
  return /Social Media Cookies|Just a moment|challenges\.cloudflare/i.test(text);
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
    const extracted = await extractGuidePage(url, signal);
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
    const extracted = await extractGuidePage(page.url, signal);
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
  if (hinted?.sectionSlug) add(rawUrl);
  add(`${parsed.canonicalUrl}/introduction`);
  add(`${parsed.canonicalUrl}/walkthrough`);
  add(parsed.canonicalUrl);
  return out;
}

async function discoverGamefaqsBundleViaExtract(
  parsed: ParsedFaq,
  rawUrl: string,
  seedPages: BundlePage[],
  signal?: AbortSignal,
): Promise<{ pages: BundlePage[]; title: string }> {
  let bestTitle = "GameFAQs guide";

  for (const url of buildExtractCandidates(parsed, rawUrl)) {
    const extracted = await extractGuidePage(url, signal);
    if (!extracted?.content || isBlockedGuideContent(extracted.content)) continue;

    const title = parseGamefaqsGuideTitle(extracted.content, parsed);
    if (!isGenericGamefaqsBundleTitle(title)) bestTitle = title;

    const fromToc = parseGamefaqsTocFromHtml(extracted.content, parsed);
    const merged = mergeGamefaqsBundlePages([...seedPages, ...fromToc]);
    if (merged.length <= 1) continue;

    return {
      pages: merged,
      title: bestTitle,
    };
  }

  return { pages: seedPages, title: bestTitle };
}

async function discoverViaTavily(
  parsed: ParsedFaq,
  signal?: AbortSignal,
  seedPages: BundlePage[] = [],
): Promise<{ pages: BundlePage[]; title: string }> {
  const fromExtract = await discoverGamefaqsBundleViaExtract(parsed, parsed.canonicalUrl, seedPages, signal);
  if (fromExtract.pages.length > 1) {
    const enriched = await enrichBundlePagesFromExtracts(parsed, fromExtract.pages, signal);
    return { pages: enriched, title: fromExtract.title };
  }

  const fromSearch = await discoverGamefaqsBundleViaSearch(parsed, signal, seedPages);
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
): Promise<{ pages: BundlePage[]; title: string }> {
  const cached = await getCachedBundleDiscovery(parsed.bundleKey, { allowStale: true });
  const fromDb = await getIndexedBundlePagesFromDb(parsed.bundleKey);
  const pages = mergeGamefaqsBundlePages([...(cached?.pages ?? []), ...fromDb]);
  return { pages, title: cached?.title ?? "GameFAQs guide" };
}

async function discoverGamefaqsBundleCacheFirst(
  parsed: ParsedFaq,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<BundleDiscovery> {
  const { pages: seedPages, title } = await discoverFromCacheAndDb(parsed);
  if (seedPages.length > 1) {
    return buildBundleDiscovery(parsed, seedPages, title);
  }

  const direct = await discoverGamefaqsBundle(rawUrl, signal);
  if (direct.bundle && direct.pages?.length) {
    const merged = await mergeAndCacheDiscovery(
      parsed,
      direct.pages,
      direct.title ?? title,
    );
    if (merged.length > 1) {
      return buildBundleDiscovery(parsed, merged, direct.title ?? title);
    }
  }

  const extracted = await discoverGamefaqsBundleViaExtract(parsed, rawUrl, seedPages, signal);
  if (extracted.pages.length > 1) {
    const merged = await mergeAndCacheDiscovery(parsed, extracted.pages, extracted.title);
    if (merged.length > 1) {
      return buildBundleDiscovery(parsed, merged, extracted.title);
    }
  }

  // ponytail: Tavily extract often drops GameFAQs sidebar TOC — one quick site search.
  const fromSearch = await discoverGamefaqsBundleViaSearch(parsed, signal, seedPages, {
    partQueries: false,
    enrich: false,
    earlyExitMinPages: 2,
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

  return direct.bundle ? direct : { bundle: false };
}

async function discoverGamefaqsBundleFull(
  parsed: ParsedFaq,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<BundleDiscovery> {
  const cached = await getCachedBundleDiscovery(parsed.bundleKey);
  const seedPages = mergeGamefaqsBundlePages([
    ...(cached?.pages ?? []),
    ...(await getIndexedBundlePagesFromDb(parsed.bundleKey)),
  ]);

  const direct = await discoverGamefaqsBundle(rawUrl, signal);
  if (direct.bundle && direct.pages?.length) {
    const directTitle = await resolveDiscoveryTitle(
      parsed,
      direct.title ?? "GameFAQs guide",
      signal,
    );
    const merged = await mergeAndCacheDiscovery(parsed, direct.pages, directTitle);
    if (merged.length > 1) {
      return buildBundleDiscovery(
        parsed,
        merged,
        pickGamefaqsBundleTitle(directTitle, cached?.title),
      );
    }
  }

  const fresh = await discoverViaTavily(parsed, signal, seedPages);
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

  return direct.bundle ? direct : { bundle: false };
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
