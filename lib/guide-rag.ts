import { getServerClient } from "@/lib/supabase-server";

import { embedQuery } from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import {
  ensureGuideIngested,
  getGuideDisplayTitles,
  guideStorageKey,
  isGuideRagAvailable,
  normalizeGuideUrl,
} from "@/lib/guide-ingest";
import { canonicalGamefaqsBundleUrl } from "@/lib/gamefaqs-bundle.js";
import { normalizeGuideUrlList } from "@/lib/guide-urls.js";
import type { SearchResult } from "@/lib/tavily";
import { rescoreGuideChunks } from "@/lib/guide-rescore.js";
import { cohereRerankChunks } from "@/lib/guide-rerank-cohere";
import { logTraceEvent } from "@/lib/trace";


// Cosine hit threshold for text-embedding-3-large @ 1024-dim (Sumopod).
// Calibrated 2026-07-22 via `npm run eval:rag` (Suikoden guide, Indonesian
// questions). In-guide tops clustered 0.28–0.42, non-game off-guide at 0.03–0.09,
// but a same-domain off-guide ("beat Sephiroth?") hit 0.348 — inside the in-guide
// band. A hard cosine cutoff tops out ~90% here; threshold is NOT the lever.
// 0.35 kept as the best available split. Real fix = Phase C reranker + Phase D
// hybrid BM25 (exact names like "Sylvina"/"Armor Shop" that embeddings miss).
// See docs/plan/rag-tuning-roadmap.md.
export const GUIDE_HIT = 0.35;
// Kept at 5 (not lowered to 3): calibration showed the targeted paragraph often
// ranks 2–3, so overfetch gives Gemini the right chunk until a reranker lands.
const RETRIEVE_K = 5;

// Over-fetch, then collapse identical chunk text down to RETRIEVE_K distinct. A
// GameFAQs `?print=1` guide can be stored under many section URLs with byte-identical
// content, so the raw top-K can be 5 copies of one chunk — this restores diversity for
// both legacy 25×-duplicated data and anything new.
const RETRIEVE_FETCH = RETRIEVE_K * 4;

/** On by default. Set GUIDE_RULES_AFTER_COHERE=0 to let Cohere own final chunk order (revert). */
function rulesRescoreAfterCohereEnabled(): boolean {
  return process.env.GUIDE_RULES_AFTER_COHERE !== "0";
}

function rulesRescoreMatches(
  matches: MatchRow[],
  question: string,
  searchTopic: string,
): MatchRow[] {
  return rescoreGuideChunks({
    query: question,
    searchTopic,
    chunks: matches,
  }) as MatchRow[];
}

/** Keep only the first (highest-similarity) occurrence of each distinct chunk text. */
function dedupeByChunkText<T extends { chunk_text?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = (row.chunk_text ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

let ragUnavailableLogged = false;

type MatchRow = {
  guide_url: string;
  chunk_text: string;
  chunk_index: number;
  section_path: string[];
  section_confidence: number | null;
  similarity: number;
  rescore_delta?: number;
  rescore_reasons?: string[];
  rescore_score?: number;
};

export type GuideRagResult = {
  sources: SearchResult[];
  skipWebSearch: boolean;
  hubWarning: boolean;
  indexedCount: number;
  totalGuides: number;
  // All retrieved similarities (top-K), for calibration harness only. Populated
  // when a match ran; undefined on ingest-miss/infra-miss short-circuits.
  scores?: number[];
  // Retrieved chunk texts (top-K), calibration harness only — lets it check
  // whether the targeted paragraph landed anywhere in top-K, not just rank 1.
  chunkTexts?: string[];
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
  for (const raw of urls) {
    const canonical = canonicalGamefaqsBundleUrl(raw);
    const key = normalizeGuideUrl(canonical ?? raw);
    if (!guideUrls.includes(key)) guideUrls.push(key);
  }
  return guideUrls;
}

/**
 * Preferred-guide RAG path: ingest (lazy), embed query, retrieve top-K chunks
 * across one or more guide URLs and/or bundles. Returns null when RAG
 * infra is unavailable so the caller can fall back to tiered web search.
 */
export async function retrieveFromPreferredGuides(input: {
  guideUrls: string[];
  query: string;
  /** Raw player question — used for rules rescoring (progress/location tokens). */
  question?: string;
  signal?: AbortSignal;
  game?: string;
  platform?: string;
  userId?: string | null;
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
    preferred.map((guideUrl) =>
      ensureGuideIngested(guideUrl, input.signal, {
        game: input.game,
        platform: input.platform,
        userId: input.userId,
      }),
    ),
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
  const guideUrls = resolveRagTargets(indexedPreferred);

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
      p_guide_bundles: [],
      p_embedding: toVectorString(queryEmbedding),
      p_limit: RETRIEVE_FETCH,
    });
    if (error) throw error;
    const raw = dedupeByChunkText((data ?? []) as MatchRow[]);
    matches = rulesRescoreMatches(raw, input.question ?? input.query, input.query).slice(
      0,
      RETRIEVE_K,
    );
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

  // Phase C rerank (opt-in via COHERE_API_KEY presence): cosine recall@K is good but
  // ordering + routing is not (calibration 2026-07-22 — cosine 9/10 rank-1 3/6;
  // Cohere rerank-v3.5 10/10 rank-1 6/6). Cohere supplies the `relevant` routing
  // verdict; progress-aware rules rescoring owns final order (see rules-after-cohere
  // pass below). Fully fail-open: any Cohere error returns null → cosine GUIDE_HIT.
  let rerankRelevant: boolean | null = null;
  let rulesAfterCohere = false;
  if (process.env.COHERE_API_KEY && matches.length > 1) {
    const rr = await cohereRerankChunks({
      question: input.query,
      chunks: matches.map((m) => m.chunk_text),
      signal: input.signal,
    });
    if (rr) {
      // rerank_start/ok/error is traced inside cohereRerankChunks; the routing
      // outcome (reranked + hit) is captured by rag_similarity_score below.
      matches = rr.order.map((i) => matches[i]).filter(Boolean);
      rerankRelevant = rr.relevant;
      if (rulesRescoreAfterCohereEnabled()) {
        matches = rulesRescoreMatches(matches, input.question ?? input.query, input.query);
        rulesAfterCohere = true;
      }
    }
  }

  const topSimilarity = matches[0]?.similarity ?? 0;
  const topRescoreScore = matches[0]?.rescore_score ?? topSimilarity;
  // Rerank verdict wins when it ran (semantic relevance); else cosine threshold.
  const hit = rerankRelevant != null ? rerankRelevant : topSimilarity >= GUIDE_HIT;
  const titleByUrl = await getGuideDisplayTitles(matches.map((row) => row.guide_url));
  const labelFor = (guideUrl: string) =>
    titleByUrl.get(guideStorageKey(guideUrl)) ?? hostLabel(guideUrl);
  void logTraceEvent("rag_similarity_score", `Top RAG similarity: ${topSimilarity.toFixed(3)} (Hit: ${hit}, reranked: ${rerankRelevant != null})`, undefined, {
    topSimilarity,
    topRescoreScore,
    hit,
    threshold: GUIDE_HIT,
    reranked: rerankRelevant != null,
    rules_rescored: true,
    rules_after_cohere: rulesAfterCohere,
    chunks: matches.map((row, index) => ({
      title: labelFor(row.guide_url) + (matches.length > 1 ? ` (section ${index + 1})` : ""),
      url: row.guide_url,
      similarity: row.similarity,
      rescore_score: row.rescore_score,
      rescore_delta: row.rescore_delta,
      rescore_reasons: row.rescore_reasons,
      section_path: row.section_path,
      preview: row.chunk_text.slice(0, 600),
    })),
  });

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
    const label = labelFor(row.guide_url);
    return {
      title: hit ? `${label} (section ${index + 1})` : label,
      url: row.guide_url,
      content: row.chunk_text,
      score: row.rescore_score ?? row.similarity,
      preferred: hit,
    };
  });

  return {
    // ponytail: on miss, don't surface a guide chunk as a cited source — web
    // fallback (or knowledge-only) owns the answer footer's provenance label.
    sources: hit ? sources : [],
    skipWebSearch: hit,
    hubWarning,
    indexedCount,
    totalGuides,
    scores: matches.map((m) => m.similarity),
    chunkTexts: matches.map((m) => m.chunk_text),
  };
}
