import { getServerClient } from "@/lib/supabase-server";

import {
  EMBED_MODEL_PREFERENCE,
  embedQuery,
  getUsableEmbedModels,
  isEmbedModelAvailable,
  SUMOPOD_MODEL_TAG,
  syncSumopodHealth,
} from "@/lib/embed";
import { toVectorString } from "@/lib/embed-cache";
import { AUTO_REFRESH_MAX_CHUNKS, resolveGuideModelChoice } from "@/lib/guide-embed-state.js";
import {
  ensureGuideIngested,
  getGuideDisplayTitles,
  getGuideEmbedSummary,
  guideStorageKey,
  isDualVectorRpcReady,
  isGuideRagAvailable,
  normalizeGuideUrl,
  raceAbort,
} from "@/lib/guide-ingest";
import { canonicalGamefaqsBundleUrl } from "@/lib/gamefaqs-bundle.js";
import { normalizeGuideUrlList } from "@/lib/guide-urls.js";
import type { SearchResult } from "@/lib/tavily";
import {
  buildPhraseTsQuery,
  extractEntityPhrases,
  retrievalScore,
} from "@/lib/guide-lexical.js";
import { rescoreGuideChunks } from "@/lib/guide-rescore.js";
import { cohereRerankChunks } from "@/lib/guide-rerank-cohere";
import {
  extractPositionLandmarks,
  hasContinuationOpening,
  markTailNeighborInPool,
} from "@/lib/guide-progress.js";
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
  history: ProgressTurn[] = [],
): MatchRow[] {
  return rescoreGuideChunks({
    query: question,
    searchTopic,
    history,
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
  /** 1-based rank from the lexical phrase search; 0 when found by vector only. */
  lexical_rank?: number;
  /** Cosine fused with the lexical hit — what the rescorer ranks on. */
  retrieval_score?: number;
  rescore_delta?: number;
  rescore_reasons?: string[];
  rescore_score?: number;
  neighbor_of_tail?: boolean;
};

type ProgressTurn = { role?: string; content?: string };

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

/** Ensure chunk_index+1 from the best tail-endpoint parent is in the pool (fetch or mark). */
async function ensureTailNeighbor(
  supabase: NonNullable<ReturnType<typeof getServerClient>>,
  rows: MatchRow[],
  landmarks: string[],
): Promise<MatchRow[]> {
  if (!landmarks.length || !rows.length) return rows;

  const { rows: markedRows, parent, marked } = markTailNeighborInPool(rows, landmarks);
  if (!parent?.guide_url || parent.chunk_index == null) return markedRows as MatchRow[];
  if (marked) return markedRows as MatchRow[];

  const nextIndex = parent.chunk_index + 1;
  const { data, error } = await supabase
    .from("guide_chunks")
    .select("guide_url, chunk_text, chunk_index, section_path, section_confidence")
    .eq("guide_url", parent.guide_url)
    .eq("chunk_index", nextIndex)
    .maybeSingle();

  if (error || !data || !hasContinuationOpening(data.chunk_text)) return markedRows as MatchRow[];

  return [
    ...(markedRows as MatchRow[]),
    {
      guide_url: data.guide_url,
      chunk_text: data.chunk_text,
      chunk_index: data.chunk_index,
      section_path: data.section_path ?? [],
      section_confidence: data.section_confidence ?? null,
      similarity: (Number(parent.similarity) || 0) * 0.94,
      retrieval_score: (Number(parent.retrieval_score ?? parent.similarity) || 0) * 0.94,
      neighbor_of_tail: true,
    },
  ];
}

let hybridRpcMissingLogged = false;

/**
 * Vector top-K unioned with lexical phrase hits. Falls back to vector-only when the
 * install has not applied `db/guide-chunks-hybrid.sql`.
 */
async function fetchCandidates(
  supabase: NonNullable<ReturnType<typeof getServerClient>>,
  guideUrls: string[],
  embedding: string,
  lexicalQuery: string,
): Promise<MatchRow[]> {
  if (lexicalQuery) {
    const { data, error } = await supabase.rpc("match_guide_chunks_hybrid", {
      p_guide_urls: guideUrls,
      p_guide_bundles: [],
      p_embedding: embedding,
      p_limit: RETRIEVE_FETCH,
      p_lexical_query: lexicalQuery,
    });
    if (!error) return (data ?? []) as MatchRow[];
    if (!hybridRpcMissingLogged) {
      console.warn(
        "match_guide_chunks_hybrid unavailable, using vector-only retrieval. " +
          "Apply db/guide-chunks-hybrid.sql to enable exact-name search.",
        error.message,
      );
      hybridRpcMissingLogged = true;
    }
  }

  const { data, error } = await supabase.rpc("match_guide_chunks", {
    p_guide_urls: guideUrls,
    p_guide_bundles: [],
    p_embedding: embedding,
    p_limit: RETRIEVE_FETCH,
  });
  if (error) throw error;
  return (data ?? []) as MatchRow[];
}

let modelRpcMissingLogged = false;
let dualRpcMissingUntil = 0;

/** Metadata needed to pick primary vs backup vectors and classify guide health. */
async function loadGuideEmbedMeta(guideUrls: string[]) {
  const entries = await Promise.all(
    guideUrls.map(async (url) => [url, await getGuideEmbedSummary(url)] as const),
  );
  return new Map(entries);
}

/**
 * Candidates for guides that share one embedding model. `embedding` null means
 * that model is unavailable right now: lexical-only via chunk_tsv. Never compares
 * vectors across models (the RPC filters on embed_model / embed_model_next).
 */
async function fetchModelCandidates(
  supabase: NonNullable<ReturnType<typeof getServerClient>>,
  guideUrls: string[],
  model: string,
  embedding: number[] | null,
  lexicalQuery: string,
): Promise<MatchRow[]> {
  if (!embedding && !lexicalQuery) return [];
  const embeddingStr = embedding ? toVectorString(embedding) : null;
  if (Date.now() >= dualRpcMissingUntil) {
    const { data: dualData, error: dualError } = await supabase.rpc("match_guide_chunks_dual", {
      p_guide_urls: guideUrls,
      p_embedding: embeddingStr,
      p_limit: RETRIEVE_FETCH,
      p_lexical_query: lexicalQuery,
      p_embed_model: model,
    });
    if (!dualError) return (dualData ?? []) as MatchRow[];
    dualRpcMissingUntil = Date.now() + 30_000;
    if (!modelRpcMissingLogged) {
      console.warn(
        "match_guide_chunks_dual unavailable, using match_guide_chunks_model. " +
          "Apply db/guide-chunks-dual-embed.sql.",
        dualError.message,
      );
    }
  }
  const { data, error } = await supabase.rpc("match_guide_chunks_model", {
    p_guide_urls: guideUrls,
    p_embedding: embeddingStr,
    p_limit: RETRIEVE_FETCH,
    p_lexical_query: lexicalQuery,
    p_embed_model: model,
  });
  if (!error) return (data ?? []) as MatchRow[];
  if (!modelRpcMissingLogged) {
    console.warn(
      "match_guide_chunks_model unavailable, using legacy retrieval. " +
        "Apply db/embed-model-tag.sql.",
      error.message,
    );
    modelRpcMissingLogged = true;
  }
  // Pre-migration install: every guide is Sumopod, so the legacy RPCs are correct.
  if (model !== SUMOPOD_MODEL_TAG || !embeddingStr) return [];
  return fetchCandidates(supabase, guideUrls, embeddingStr, lexicalQuery);
}

export type DegradedGuideInfo = {
  guideUrl: string;
  chunkCount: number;
  canRefresh: boolean;
  autoRefreshable: boolean;
};

export type GuideRagResult = {
  sources: SearchResult[];
  skipWebSearch: boolean;
  hubWarning: boolean;
  indexedCount: number;
  totalGuides: number;
  /** Indexing is paused (embed providers down or cleanup blocked), not just partial. */
  embedFailed?: boolean;
  lexicalOnly?: boolean;
  degradedGuides?: DegradedGuideInfo[];
  scores?: number[];
  chunkTexts?: string[];
};

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
  /** Chat history — used for owned-item penalties during rescoring. */
  history?: ProgressTurn[];
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

  // The shared ingest runs without our signal (L14); Stop only ends this wait, the guide still indexes.
  const ingestResults = await raceAbort(
    Promise.all(
      preferred.map((guideUrl) =>
        ensureGuideIngested(guideUrl, input.signal, {
          game: input.game,
          platform: input.platform,
          userId: input.userId,
        }),
      ),
    ),
    input.signal,
  );
  if (!ingestResults) return null;
  const embedFailed = ingestResults.some((result) => result.embedFailed);
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
      ...(embedFailed ? { embedFailed } : {}),
    };
  }

  const indexedPreferred = preferred.filter((_, index) => ingestResults[index]?.indexed);
  const guideUrls = resolveRagTargets(indexedPreferred);

  const supabase = getServerClient();
  if (!supabase) return null;

  let matches: MatchRow[] = [];
  let lexicalOnly = false;
  let degradedGuides: DegradedGuideInfo[] = [];
  const history = input.history ?? [];
  const noMatchResult = {
    sources: [],
    skipWebSearch: false,
    hubWarning,
    indexedCount,
    totalGuides,
  };
  try {
    const start = Date.now();
    // Names the player used ("Slime Eye", "Key Cavern") are what embeddings miss
    // inside a single walkthrough, so search for them literally as well.
    const phrases = extractEntityPhrases(input.query, input.game);
    const lexicalQuery = buildPhraseTsQuery(phrases);

    await syncSumopodHealth();
    const guideMeta = await loadGuideEmbedMeta(guideUrls);
    const hasAnyNext = [...guideMeta.values()].some((m) => Boolean(m.embedModelNext));
    const dualRpcReady = hasAnyNext ? await isDualVectorRpcReady(supabase) : false;
    const usableModels = getUsableEmbedModels();

    const degradedMap = new Map<string, DegradedGuideInfo>();
    const recordDegraded = (url: string, chunkCount: number, canRefresh: boolean) => {
      degradedMap.set(url, {
        guideUrl: url,
        chunkCount,
        canRefresh,
        autoRefreshable: canRefresh && chunkCount > 0 && chunkCount <= AUTO_REFRESH_MAX_CHUNKS,
      });
    };

    type QueryGroup = { model: string; urls: string[]; vectorExpected: boolean };
    const groupMap = new Map<string, QueryGroup>();
    const addToGroup = (model: string, vectorExpected: boolean, url: string) => {
      const key = `${model}:${vectorExpected ? "v" : "l"}`;
      const existing = groupMap.get(key);
      if (existing) existing.urls.push(url);
      else groupMap.set(key, { model, urls: [url], vectorExpected });
    };

    for (const url of guideUrls) {
      const meta = guideMeta.get(url);
      const embedModel = meta?.embedModel ?? SUMOPOD_MODEL_TAG;
      const embedModelNext = dualRpcReady ? (meta?.embedModelNext ?? null) : null;
      const choice = resolveGuideModelChoice({
        embedModel,
        embedModelNext,
        usableModels,
        preferredOrder: EMBED_MODEL_PREFERENCE,
      });
      if (choice.activeModel) {
        addToGroup(choice.activeModel, true, url);
      } else {
        addToGroup(embedModel, false, url);
        recordDegraded(url, meta?.chunkCount ?? 0, choice.canRefresh);
      }
    }

    const embedForUrls = (model: string, urls: string[]) =>
      isEmbedModelAvailable(model)
        ? embedQuery(
            input.query,
            input.signal,
            {
              purpose: "rag_query",
              game: input.game,
              platform: input.platform,
              userId: input.userId,
              guideUrl: urls[0],
            },
            model,
          )
        : Promise.resolve(null);

    const groups = await Promise.all(
      [...groupMap.values()].map(async (group) => {
        const embedded = group.vectorExpected
          ? await embedForUrls(group.model, group.urls)
          : null;

        // Mid-turn failover when Sumopod just tripped its breaker on this query:
        // try any stored backup vector for those URLs, else record degraded for heal/Refresh.
        if (group.vectorExpected && !embedded && group.model === SUMOPOD_MODEL_TAG) {
          const usableAfter = getUsableEmbedModels();
          const rows: MatchRow[] = [];
          let recoveredVector = false;
          const fallbackUrls: string[] = [];
          const nextGroups = new Map<string, string[]>();

          for (const url of group.urls) {
            const meta = guideMeta.get(url);
            const embedModel = meta?.embedModel ?? SUMOPOD_MODEL_TAG;
            const embedModelNext = dualRpcReady ? (meta?.embedModelNext ?? null) : null;
            const choiceAfter = resolveGuideModelChoice({
              embedModel,
              embedModelNext,
              usableModels: usableAfter,
              preferredOrder: EMBED_MODEL_PREFERENCE,
            });
            if (choiceAfter.activeModel && choiceAfter.activeModel !== SUMOPOD_MODEL_TAG) {
              nextGroups.set(choiceAfter.activeModel, [
                ...(nextGroups.get(choiceAfter.activeModel) ?? []),
                url,
              ]);
            } else {
              fallbackUrls.push(url);
              recordDegraded(url, meta?.chunkCount ?? 0, choiceAfter.canRefresh);
            }
          }

          for (const [backupModel, backupUrls] of nextGroups) {
            const backupEmbed = await embedForUrls(backupModel, backupUrls);
            if (backupEmbed) recoveredVector = true;
            else {
              for (const url of backupUrls) {
                const meta = guideMeta.get(url);
                recordDegraded(url, meta?.chunkCount ?? 0, false);
              }
            }
            rows.push(
              ...(await fetchModelCandidates(
                supabase,
                backupUrls,
                backupModel,
                backupEmbed?.vector ?? null,
                lexicalQuery,
              )),
            );
          }

          if (fallbackUrls.length) {
            rows.push(
              ...(await fetchModelCandidates(
                supabase,
                fallbackUrls,
                group.model,
                null,
                lexicalQuery,
              )),
            );
          }
          return { model: group.model, rows, vector: recoveredVector };
        }

        const rows = await fetchModelCandidates(
          supabase,
          group.urls,
          group.model,
          embedded?.vector ?? null,
          lexicalQuery,
        );
        return { model: group.model, rows, vector: Boolean(embedded) };
      }),
    );

    degradedGuides = [...degradedMap.values()];
    lexicalOnly = groups.every((group) => !group.vector);
    const rows = groups.flatMap((group) => group.rows);
    const raw = dedupeByChunkText(rows).map((row) => ({
      ...row,
      retrieval_score: retrievalScore(row),
    }));
    const landmarks = extractPositionLandmarks(
      `${input.question ?? ""} ${input.query}`.trim(),
    );
    const neighbors = await ensureTailNeighbor(supabase, raw, landmarks);
    const pool = dedupeByChunkText(neighbors);
    matches = rulesRescoreMatches(
      pool,
      input.question ?? input.query,
      input.query,
      history,
    ).slice(0, RETRIEVE_K);
    void logTraceEvent("rag_db_check", "Checked DB for RAG chunks", Date.now() - start, {
      matchCount: matches.length,
      candidateCount: pool.length,
      lexicalPhrases: phrases,
      lexicalHits: pool.filter((row) => row.lexical_rank).length,
      models: groups.map((group) => ({ model: group.model, vector: group.vector })),
      lexicalOnly,
      ...(degradedGuides.length ? { degradedCount: degradedGuides.length } : {}),
    });
  } catch (error) {
    console.error("Guide chunk retrieval failed:", error);
    return noMatchResult;
  }

  if (!matches.length) {
    return {
      sources: [],
      skipWebSearch: false,
      hubWarning,
      indexedCount,
      totalGuides,
      lexicalOnly,
      ...(degradedGuides.length ? { degradedGuides } : {}),
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
        matches = rulesRescoreMatches(
          matches,
          input.question ?? input.query,
          input.query,
          history,
        );
        rulesAfterCohere = true;
      }
    }
  }

  const topSimilarity = matches[0]?.similarity ?? 0;
  const topRescoreScore = matches[0]?.rescore_score ?? topSimilarity;
  // Rerank verdict wins when it ran (semantic relevance); else cosine threshold.
  // Lexical-only rows (model unavailable) carry cosine 0: an exact name match in the
  // guide is the only signal, so it counts as a hit when no reranker ruled.
  const lexicalOnlyHit = topSimilarity === 0 && (matches[0]?.lexical_rank ?? 0) > 0;
  const hit = rerankRelevant != null ? rerankRelevant : topSimilarity >= GUIDE_HIT || lexicalOnlyHit;
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
      lexical_rank: row.lexical_rank ?? 0,
      retrieval_score: row.retrieval_score,
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
    lexicalOnly,
    ...(degradedGuides.length ? { degradedGuides } : {}),
    scores: matches.map((m) => m.similarity),
    chunkTexts: matches.map((m) => m.chunk_text),
  };
}
