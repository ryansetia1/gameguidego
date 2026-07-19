import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { embedQuery } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import {
  ensureGuideIngested,
  isGuideRagAvailable,
  normalizeGuideUrl,
} from "@/lib/guide-ingest";
import { parseGamefaqsFaqUrl } from "@/lib/gamefaqs-bundle.js";
import {
  isGamefaqsBundleUrl,
  normalizeGuideUrlList,
} from "@/lib/guide-urls.js";
import type { SearchResult } from "@/lib/tavily";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ponytail: hand-tuned cosine threshold for Qwen3; tune in one place.
export const GUIDE_HIT = 0.35;
const RETRIEVE_K = 5;

let client: SupabaseClient | null = null;
let ragUnavailableLogged = false;

function getClient(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

type MatchRow = {
  guide_url: string;
  chunk_text: string;
  similarity: number;
};

export type GuideRagResult = {
  sources: SearchResult[];
  skipWebSearch: boolean;
  hubWarning: boolean;
  indexedCount: number;
  totalGuides: number;
};

function hostLabel(guideUrl: string): string {
  try {
    return new URL(guideUrl).hostname.replace(/^www\./, "");
  } catch {
    return "Preferred guide";
  }
}

function resolveRagTargets(urls: string[]) {
  const guideUrls: string[] = [];
  const guideBundles: string[] = [];
  for (const raw of urls) {
    const parsed = parseGamefaqsFaqUrl(raw);
    if (parsed && isGamefaqsBundleUrl(raw)) {
      if (!guideBundles.includes(parsed.bundleKey)) guideBundles.push(parsed.bundleKey);
    } else {
      guideUrls.push(normalizeGuideUrl(raw));
    }
  }
  return { guideUrls, guideBundles };
}

/**
 * Preferred-guide RAG path: ingest (lazy), embed query, retrieve top-K chunks
 * across one or more guide URLs and/or bundles. Returns null when RAG
 * infra is unavailable so the caller can fall back to tiered web search.
 */
export async function retrieveFromPreferredGuides(input: {
  guideUrls: string[];
  query: string;
  signal?: AbortSignal;
}): Promise<GuideRagResult | null> {
  const preferred = normalizeGuideUrlList(input.guideUrls);
  if (!preferred.length) return null;

  if (!isGuideRagAvailable()) {
    if (!ragUnavailableLogged) {
      console.warn("Preferred-guide RAG unavailable; falling back to web search.");
      ragUnavailableLogged = true;
    }
    return null;
  }

  const ingestResults = await Promise.all(
    preferred.map((guideUrl) => ensureGuideIngested(guideUrl, input.signal)),
  );
  const hubWarning = ingestResults.some((result) => result.hubWarning);
  const indexedCount = ingestResults.filter((result) => result.indexed).length;
  const totalGuides = preferred.length;

  if (!indexedCount) {
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount: 0,
      totalGuides,
    };
  }

  const indexedPreferred = preferred.filter((_, index) => ingestResults[index]?.indexed);
  const { guideUrls, guideBundles } = resolveRagTargets(indexedPreferred);

  const queryEmbedding = await embedQuery(input.query, input.signal);
  if (!queryEmbedding?.length) {
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount,
      totalGuides,
    };
  }

  const supabase = getClient();
  if (!supabase) return null;

  let matches: MatchRow[] = [];
  try {
    const { data, error } = await supabase.rpc("match_guide_chunks", {
      p_guide_urls: guideUrls,
      p_guide_bundles: guideBundles,
      p_embedding: toVectorString(queryEmbedding),
      p_limit: RETRIEVE_K,
    });
    if (error) throw error;
    matches = (data ?? []) as MatchRow[];
  } catch (error) {
    console.error("Guide chunk retrieval failed:", error);
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount,
      totalGuides,
    };
  }

  if (!matches.length) {
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount,
      totalGuides,
    };
  }

  const topSimilarity = matches[0]?.similarity ?? 0;
  const hit = topSimilarity >= GUIDE_HIT;

  const sources: SearchResult[] = matches.map((row, index) => {
    const label = hostLabel(row.guide_url);
    return {
      title: hit ? `${label} (section ${index + 1})` : label,
      url: row.guide_url,
      content: row.chunk_text,
      score: row.similarity,
      preferred: hit,
    };
  });

  return {
    sources: hit ? sources : sources.slice(0, 1),
    skipWebSearch: hit,
    hubWarning,
    indexedCount,
    totalGuides,
  };
}

/** @deprecated Use retrieveFromPreferredGuides */
export async function retrieveFromPreferredGuide(input: {
  guideUrl: string;
  query: string;
  signal?: AbortSignal;
}): Promise<GuideRagResult | null> {
  return retrieveFromPreferredGuides({
    guideUrls: input.guideUrl ? [input.guideUrl] : [],
    query: input.query,
    signal: input.signal,
  });
}
