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

async function runDiscoveryQueries(
  parsed: ParsedFaq,
  queries: string[],
  seedPages: BundlePage[],
  signal?: AbortSignal,
): Promise<BundlePage[]> {
  const seenUrls = new Set<string>();
  const mergedHits: { url: string }[] = [];

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
    for (const hit of hits) {
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);
      mergedHits.push(hit);
    }
  }

  const fromUrls = parseGamefaqsPagesFromUrls(
    mergedHits.map((hit) => hit.url),
    parsed,
  );
  return mergeGamefaqsBundlePages([...seedPages, ...fromUrls]);
}

async function discoverGamefaqsBundleViaSearch(
  parsed: ParsedFaq,
  signal?: AbortSignal,
  seedPages: BundlePage[] = [],
): Promise<BundlePage[]> {
  let pages = mergeGamefaqsBundlePages(seedPages);

  pages = await runDiscoveryQueries(
    parsed,
    buildGamefaqsDiscoveryBaseQueries(parsed),
    pages,
    signal,
  );

  if (pages.length < PART_QUERY_PAGE_THRESHOLD) {
    pages = await runDiscoveryQueries(
      parsed,
      buildGamefaqsPartDiscoveryQueries(parsed),
      pages,
      signal,
    );
  }

  if (pages.length <= 1) return pages;
  return enrichBundlePagesFromExtracts(parsed, pages, signal);
}

async function discoverViaTavily(
  parsed: ParsedFaq,
  signal?: AbortSignal,
  seedPages: BundlePage[] = [],
): Promise<{ pages: BundlePage[]; title: string }> {
  const candidates = [
    `${parsed.canonicalUrl}/introduction`,
    `${parsed.canonicalUrl}/walkthrough`,
    parsed.canonicalUrl,
  ];

  for (const url of candidates) {
    const extracted = await extractGuidePage(url, signal);
    const pages = extracted?.content
      ? parseGamefaqsTocFromHtml(extracted.content, parsed)
      : [];
    if (!extracted?.content || pages.length <= 1) continue;

    const enriched = await enrichBundlePagesFromExtracts(
      parsed,
      mergeGamefaqsBundlePages([...seedPages, ...pages]),
      signal,
    );
    return {
      pages: enriched,
      title: parseGamefaqsGuideTitle(extracted.content, parsed) || "GameFAQs guide",
    };
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
 * Default (`refresh: false`) reads cache + DB only (no Tavily). Pass
 * `refresh: true` for a full Tavily discovery pass (add-time preview, manual refresh).
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
