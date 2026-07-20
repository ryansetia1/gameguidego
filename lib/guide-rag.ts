import { getServerClient } from "@/lib/supabase-server";

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
import { logTraceEvent } from "@/lib/trace";


// ponytail: hand-tuned cosine threshold for Qwen3; tune in one place.
export const GUIDE_HIT = 0.35;
const RETRIEVE_K = 5;

let ragUnavailableLogged = false;

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
  if (guideUrl.startsWith("upload://")) {
    const ext = guideUrl.split(".").pop()?.toLowerCase();
    if (ext === "pdf") return "Your PDF guide";
    if (ext === "txt") return "Your TXT guide";
    if (ext === "md") return "Your MD guide";
    return "Your uploaded guide";
  }
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
  game?: string;
  platform?: string;
  userId?: string | null;
  bundlePrefs?: Record<string, { skippedSlugs?: string[]; selectedSlugs?: string[] }>;
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
    preferred.map((guideUrl) => {
      const prefs = input.bundlePrefs?.[guideUrl];
      return ensureGuideIngested(guideUrl, input.signal, {
        game: input.game,
        platform: input.platform,
        userId: input.userId,
        skipSlugs: prefs?.skippedSlugs,
        includeSlugs: prefs?.selectedSlugs,
      });
    }),
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

  const queryEmbedding = await embedQuery(input.query, input.signal, {
    purpose: "rag_query",
    game: input.game,
    platform: input.platform,
    userId: input.userId,
    guideUrl: indexedPreferred[0],
  });
  if (!queryEmbedding?.length) {
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount,
      totalGuides,
    };
  }

  const supabase = getServerClient();
  if (!supabase) return null;

  let matches: MatchRow[] = [];
  try {
    const start = Date.now();
    const { data, error } = await supabase.rpc("match_guide_chunks", {
      p_guide_urls: guideUrls,
      p_guide_bundles: guideBundles,
      p_embedding: toVectorString(queryEmbedding),
      p_limit: RETRIEVE_K,
    });
    if (error) throw error;
    matches = (data ?? []) as MatchRow[];
    void logTraceEvent("rag_db_check", "Checked DB for RAG chunks", Date.now() - start, { matchCount: matches.length });
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
  void logTraceEvent("rag_similarity_score", `Top RAG similarity: ${topSimilarity.toFixed(3)} (Hit: ${hit})`, undefined, { topSimilarity, hit, threshold: GUIDE_HIT });

  // Calibration: set RAG_DEBUG=1 to print the retrieval scores per query, so
  // GUIDE_HIT can be tuned to sit between "guide covers this" and "it doesn't".
  if (process.env.RAG_DEBUG) {
    console.log(
      `[rag-calibrate] hit=${hit} top=${topSimilarity.toFixed(3)} ` +
        `scores=[${matches.map((m) => m.similarity.toFixed(3)).join(", ")}] ` +
        `q=${JSON.stringify(input.query)} ` +
        `top_chunk=${JSON.stringify((matches[0]?.chunk_text ?? "").slice(0, 180))}`,
    );
  }

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
