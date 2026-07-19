import { createClient } from "@supabase/supabase-js";

import { mergeGamefaqsBundlePages, titleFromGamefaqsSlug } from "./gamefaqs-bundle.js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** ponytail: TOC lists change rarely; long TTL maximises cache hits. */
export const BUNDLE_DISCOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let client = null;

function getClient() {
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * @param {unknown} value
 * @returns {{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[] } | null}
 */
export function coerceCachedBundleDiscovery(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
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
 * @returns {Promise<{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[]; fetchedAt: number } | null>}
 */
export async function getCachedBundleDiscovery(bundleKey, options = {}) {
  const supabase = getClient();
  if (!supabase || !bundleKey) return null;
  try {
    const { data, error } = await supabase
      .from("guide_bundle_cache")
      .select("data, fetched_at")
      .eq("bundle_key", bundleKey)
      .maybeSingle();
    if (error || !data) return null;

    const fetchedAt = new Date(data.fetched_at).getTime();
    if (
      !options.allowStale &&
      (Number.isNaN(fetchedAt) || Date.now() - fetchedAt > BUNDLE_DISCOVERY_TTL_MS)
    ) {
      return null;
    }

    const parsed = coerceCachedBundleDiscovery(data.data);
    if (!parsed) return null;
    return { ...parsed, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Upsert merged bundle discovery (union with any existing cached pages).
 * @param {string} bundleKey
 * @param {{ title?: string; canonicalUrl?: string; pages: { slug: string; title: string; url: string }[] }} payload
 */
export async function setCachedBundleDiscovery(bundleKey, payload) {
  const supabase = getClient();
  if (!supabase || !bundleKey || !payload?.pages?.length) return;
  try {
    const existing = await getCachedBundleDiscovery(bundleKey);
    const pages = mergeGamefaqsBundlePages([
      ...(existing?.pages ?? []),
      ...payload.pages,
    ]);
    const data = {
      title: payload.title ?? existing?.title ?? "GameFAQs guide",
      canonicalUrl: payload.canonicalUrl ?? existing?.canonicalUrl ?? "",
      pages,
    };
    const { error } = await supabase.from("guide_bundle_cache").upsert(
      {
        bundle_key: bundleKey,
        data,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "bundle_key" },
    );
    if (error) console.error("guide_bundle_cache upsert failed:", error.message);
  } catch (error) {
    console.error("guide_bundle_cache upsert error:", error);
  }
}

/**
 * Pages already indexed in guide_chunks (self-heal discovery gaps).
 * @param {string} bundleKey
 * @returns {Promise<{ slug: string; title: string; url: string }[]>}
 */
export async function getIndexedBundlePagesFromDb(bundleKey) {
  const supabase = getClient();
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
      let slug = "";
      try {
        const match = new URL(guideUrl).pathname.match(
          new RegExp(`/faqs/${faqId}/([a-z0-9][a-z0-9-]*)`, "i"),
        );
        slug = match ? match[1].toLowerCase() : "";
      } catch {
        return [];
      }
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
