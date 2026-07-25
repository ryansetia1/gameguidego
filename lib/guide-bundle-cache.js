import { getServerClient } from "./supabase-server.js";

import { mergeGamefaqsBundlePages, pickGamefaqsBundleTitle, slugFromGamefaqsPageUrl, titleFromGamefaqsSlug } from "./gamefaqs-bundle.js";

/** ponytail: TOC lists change rarely; long TTL maximises cache hits. */
export const BUNDLE_DISCOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BUNDLE_BLOCKED_TTL_MS = 12 * 60 * 60 * 1000;


/** Valid per-page failure reasons persisted in the cache. */
export const PAGE_FAIL_REASONS = ["blocked", "not_found"];

/**
 * Coerce a persisted `pageStatus` map: `{ [slug]: "blocked" | "not_found" }`.
 * @param {unknown} value
 * @returns {Record<string, string> | undefined}
 */
export function coercePageStatus(value) {
  if (!value || typeof value !== "object") return undefined;
  const out = /** @type {Record<string, string>} */ ({});
  for (const [slug, reason] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (typeof slug === "string" && slug && PAGE_FAIL_REASONS.includes(/** @type {string} */ (reason))) {
      out[slug.toLowerCase()] = /** @type {string} */ (reason);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @typedef {{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[]; isBlocked?: boolean; singlePage?: boolean; pageStatus?: Record<string, string> }} CachedBundleDiscovery
 */

/**
 * @param {unknown} value
 * @returns {CachedBundleDiscovery | null}
 */
export function coerceCachedBundleDiscovery(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const pageStatus = coercePageStatus(record.pageStatus);
  /** @param {Record<string, unknown>} obj @returns {CachedBundleDiscovery} */
  const withStatus = (obj) =>
    pageStatus ? { .../** @type {CachedBundleDiscovery} */ (obj), pageStatus } : /** @type {CachedBundleDiscovery} */ (obj);
  if (record.singlePage === true) {
    return withStatus({
      pages: [],
      singlePage: true,
      title: typeof record.title === "string" ? record.title.slice(0, 120) : undefined,
      canonicalUrl:
        typeof record.canonicalUrl === "string" ? record.canonicalUrl.slice(0, 300) : undefined,
    });
  }
  if (!Array.isArray(record.pages)) return pageStatus ? { pages: [], pageStatus } : null;
  const pages = record.pages.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const page = /** @type {Record<string, unknown>} */ (row);
    if (typeof page.slug !== "string" || typeof page.url !== "string") return [];
    const title =
      typeof page.title === "string" && page.title.trim()
        ? page.title.trim()
        : page.slug;
    return [{ slug: page.slug.toLowerCase(), title, url: page.url }];
  });
  if (!pages.length) {
    if (record.isBlocked === true) return withStatus({ pages: [], isBlocked: true });
    return pageStatus ? { pages: [], pageStatus } : null;
  }
  return withStatus({
    title: typeof record.title === "string" ? record.title.slice(0, 120) : undefined,
    canonicalUrl:
      typeof record.canonicalUrl === "string" ? record.canonicalUrl.slice(0, 300) : undefined,
    pages: mergeGamefaqsBundlePages(pages),
    isBlocked: false,
  });
}

/**
 * @param {string} bundleKey
 * @param {{ allowStale?: boolean }} [options]
 * @returns {Promise<(CachedBundleDiscovery & { fetchedAt: number }) | null>}
 */
export async function getCachedBundleDiscovery(bundleKey, options = {}) {
  const supabase = getServerClient();
  if (!supabase || !bundleKey) return null;
  try {
    const { data, error } = await supabase
      .from("guide_bundle_cache")
      .select("data, fetched_at")
      .eq("bundle_key", bundleKey)
      .maybeSingle();
    if (error || !data) return null;

    const fetchedAt = new Date(data.fetched_at).getTime();
    if (Number.isNaN(fetchedAt)) return null;

    const parsed = coerceCachedBundleDiscovery(data.data);
    if (!parsed) return null;

    const ageMs = Date.now() - fetchedAt;
    // ponytail: blocked discovery always expires — never honor allowStale for isBlocked.
    if (parsed.isBlocked && ageMs > BUNDLE_BLOCKED_TTL_MS) {
      return null;
    }

    const ttl = parsed.isBlocked ? BUNDLE_BLOCKED_TTL_MS : BUNDLE_DISCOVERY_TTL_MS;
    if (!options.allowStale && ageMs > ttl) {
      return null;
    }

    return { ...parsed, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * @param {string} bundleKey
 * @param {{ title?: string; canonicalUrl?: string; pages?: { slug: string; title: string; url: string }[]; isBlocked?: boolean; singlePage?: boolean; pageStatus?: Record<string, string> }} payload
 * @returns {Promise<void>}
 */
export async function setCachedBundleDiscovery(bundleKey, payload) {
  const supabase = getServerClient();
  if (!supabase || !bundleKey) return;
  const hasContent =
    payload?.isBlocked || payload?.singlePage || payload?.pages?.length || payload?.pageStatus;
  if (!hasContent) return;

  try {
    // Only include fields that were provided: merge_guide_bundle_cache does a
    // TOP-LEVEL merge, so writing `pages: []` here would WIPE existing pages.
    const data = {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.canonicalUrl !== undefined ? { canonicalUrl: payload.canonicalUrl } : {}),
      ...(payload.pages ? { pages: payload.pages } : {}),
      ...(payload.isBlocked === true ? { isBlocked: true } : {}),
      ...(payload.isBlocked === false ? { isBlocked: false } : {}),
      ...(payload.singlePage ? { singlePage: true } : {}),
      ...(payload.pageStatus ? { pageStatus: payload.pageStatus } : {}),
    };
    const { error } = await supabase.rpc("merge_guide_bundle_cache", {
      p_bundle_key: bundleKey,
      p_new_data: data,
    });
    if (error) console.error("guide_bundle_cache rpc failed:", error.message);
  } catch (error) {
    console.error("guide_bundle_cache rpc error:", error);
  }
}

/**
 * Record why bundle pages failed to index, so the client stops re-attempting them
 * every turn and can show the reason. Merges with any existing `pageStatus`.
 * @param {string} bundleKey
 * @param {Record<string, string>} failures `{ slug: "blocked" | "not_found" }`
 * @returns {Promise<void>}
 */
export async function recordBundlePageFailures(bundleKey, failures) {
  const clean = coercePageStatus(failures);
  if (!bundleKey || !clean) return;
  const existing = await getCachedBundleDiscovery(bundleKey, { allowStale: true });
  const merged = { ...(existing?.pageStatus ?? {}), ...clean };
  await setCachedBundleDiscovery(bundleKey, { pageStatus: merged });
}

/**
 * ponytail: PostgREST caps at 1000 rows/request — paginate so large bundles
 * (e.g. 6×300 chunks) don't hide the last indexed page in status/panel.
 * @param {string} bundleKey
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchBundleChunkCountsByUrl(bundleKey) {
  const supabase = getServerClient();
  /** @type {Map<string, number>} */
  const byUrl = new Map();
  if (!supabase || !bundleKey) return byUrl;

  const pageSize = 1000;
  let from = 0;
  try {
    while (true) {
      const { data, error } = await supabase
        .from("guide_chunks")
        .select("guide_url")
        .eq("guide_bundle", bundleKey)
        .range(from, from + pageSize - 1);
      if (error) break;
      for (const row of data ?? []) {
        if (!row?.guide_url) continue;
        byUrl.set(row.guide_url, (byUrl.get(row.guide_url) ?? 0) + 1);
      }
      if (!data?.length || data.length < pageSize) break;
      from += pageSize;
    }
  } catch {
    return byUrl;
  }
  return byUrl;
}

/**
 * Pages already indexed in guide_chunks (self-heal discovery gaps).
 * @param {string} bundleKey
 * @returns {Promise<{ slug: string; title: string; url: string }[]>}
 */
export async function getIndexedBundlePagesFromDb(bundleKey) {
  const supabase = getServerClient();
  if (!supabase || !bundleKey) return [];
  try {
    const byUrl = await fetchBundleChunkCountsByUrl(bundleKey);
    if (!byUrl.size) return [];

    const faqId = bundleKey.startsWith("gamefaqs:") ? bundleKey.slice("gamefaqs:".length) : "";

    return [...byUrl.keys()].flatMap((guideUrl) => {
      const slug = slugFromGamefaqsPageUrl(guideUrl, faqId);
      if (!slug) return [];
      return [
        {
          slug,
          title: titleFromGamefaqsSlug(slug),
          url: guideUrl,
        },
      ];
    });
  } catch {
    return [];
  }
}
