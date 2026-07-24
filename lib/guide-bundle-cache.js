import { getServerClient } from "./supabase-server.js";

import { mergeGamefaqsBundlePages, pickGamefaqsBundleTitle, slugFromGamefaqsPageUrl, titleFromGamefaqsSlug } from "./gamefaqs-bundle.js";

/** ponytail: TOC lists change rarely; long TTL maximises cache hits. */
export const BUNDLE_DISCOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BUNDLE_BLOCKED_TTL_MS = 12 * 60 * 60 * 1000;


/**
 * @param {unknown} value
 * @returns {{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[]; isBlocked?: boolean; singlePage?: boolean } | null}
 */
export function coerceCachedBundleDiscovery(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.isBlocked === true) {
    return { pages: [], isBlocked: true };
  }
  if (record.singlePage === true) {
    return {
      pages: [],
      singlePage: true,
      title: typeof record.title === "string" ? record.title.slice(0, 120) : undefined,
      canonicalUrl:
        typeof record.canonicalUrl === "string" ? record.canonicalUrl.slice(0, 300) : undefined,
    };
  }
  if (!Array.isArray(record.pages)) return null;
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
  if (!pages.length) return null;
  return {
    title: typeof record.title === "string" ? record.title.slice(0, 120) : undefined,
    canonicalUrl:
      typeof record.canonicalUrl === "string" ? record.canonicalUrl.slice(0, 300) : undefined,
    pages: mergeGamefaqsBundlePages(pages),
  };
}

/**
 * @param {string} bundleKey
 * @param {{ allowStale?: boolean }} [options]
 * @returns {Promise<{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[]; isBlocked?: boolean; singlePage?: boolean; fetchedAt: number } | null>}
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
 * @param {{ title?: string; canonicalUrl?: string; pages?: { slug: string; title: string; url: string }[]; isBlocked?: boolean; singlePage?: boolean }} payload
 * @returns {Promise<void>}
 */
export async function setCachedBundleDiscovery(bundleKey, payload) {
  const supabase = getServerClient();
  if (!supabase || !bundleKey) return;
  if (!payload?.isBlocked && !payload?.singlePage && !payload?.pages?.length) return;

  try {
    const data = {
      title: payload.title,
      canonicalUrl: payload.canonicalUrl,
      pages: payload.pages ?? [],
      ...(payload.isBlocked === true ? { isBlocked: true } : {}),
      ...(payload.isBlocked === false ? { isBlocked: false } : {}),
      ...(payload.singlePage ? { singlePage: true } : {}),
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
 * Pages already indexed in guide_chunks (self-heal discovery gaps).
 * @param {string} bundleKey
 * @returns {Promise<{ slug: string; title: string; url: string }[]>}
 */
export async function getIndexedBundlePagesFromDb(bundleKey) {
  const supabase = getServerClient();
  if (!supabase || !bundleKey) return [];
  try {
    const { data, error } = await supabase
      .from("guide_chunks")
      .select("guide_url")
      .eq("guide_bundle", bundleKey);
    if (error || !data?.length) return [];

    const faqId = bundleKey.startsWith("gamefaqs:") ? bundleKey.slice("gamefaqs:".length) : "";
    const byUrl = new Map();
    for (const row of data) {
      if (!row?.guide_url) continue;
      byUrl.set(row.guide_url, (byUrl.get(row.guide_url) ?? 0) + 1);
    }

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
