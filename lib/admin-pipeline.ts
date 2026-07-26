import type { TraceEventRow } from "./admin-traces";
import { buildApiSpend, type ApiSpendSummary } from "./admin-api-spend.js";
import { buildApiCost, type ApiCostSummary } from "./admin-api-cost.js";
import { extractSnippetsFromSummarizePrompt } from "./admin-pipeline-snippets.js";

export { extractSnippetsFromSummarizePrompt };

export type PipelineSourceRow = {
  title: string;
  url: string;
  preview?: string;
  score?: number;
  similarity?: number;
};

export type PipelineRerank = {
  status: "ok" | "error" | "skipped";
  provider?: string;
  model?: string;
  topScore?: number;
  relevant?: boolean;
  message?: string;
  latencyMs?: number | null;
};

export type PipelineRag = {
  hit?: boolean;
  topSimilarity?: number;
  threshold?: number;
  reranked?: boolean;
  rules_rescored?: boolean;
  matchCount?: number;
  embedQuery?: string;
  rerank?: PipelineRerank;
  chunks: PipelineSourceRow[];
};

export type PipelineWebSearch = {
  searchTopic?: string;
  queries: string[];
  sourceCount?: number;
  latencyMs?: number | null;
  sources: PipelineSourceRow[];
};

export type PipelineCohere = PipelineRerank & {
  chunkCount?: number;
  events: TraceEventRow[];
};

export type ActivityPipeline = {
  pipelineType?: string;
  webSearch?: PipelineWebSearch;
  rag?: PipelineRag;
  cohere?: PipelineCohere;
  apiSpend?: ApiSpendSummary;
  apiCost?: ApiCostSummary;
  latencies?: {
    rewrite_ms?: number | null;
    retrieval_ms?: number | null;
    generation_ms?: number | null;
  };
  technicalExtras?: Record<string, unknown>;
};

function meta(record: TraceEventRow): Record<string, unknown> {
  return record.metadata && typeof record.metadata === "object" ? record.metadata : {};
}

function metaString(m: Record<string, unknown>, key: string): string | undefined {
  const v = m[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function metaNumber(m: Record<string, unknown>, key: string): number | undefined {
  const v = m[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function metaBool(m: Record<string, unknown>, key: string): boolean | undefined {
  const v = m[key];
  return typeof v === "boolean" ? v : undefined;
}

function parseSourceRows(value: unknown): PipelineSourceRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): PipelineSourceRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    const url = typeof r.url === "string" ? r.url : "";
    if (!title && !url) return [];
    return [
      {
        title: title || url,
        url,
        preview: typeof r.preview === "string" ? r.preview : typeof r.content === "string" ? r.content : undefined,
        score: metaNumber(r, "score"),
        similarity: metaNumber(r, "similarity"),
      },
    ];
  });
}

function normalizeSourceTitle(title: string): string {
  return title.replace(/\s*\(section \d+\)\s*$/i, "").trim().toLowerCase();
}

const WEB_RESEARCH_MARKER = "Web research (supporting evidence, may be incomplete or irrelevant):\n";

function sliceWebResearchBlock(prompt: string): string | null {
  const markerIdx = prompt.indexOf(WEB_RESEARCH_MARKER);
  if (markerIdx < 0) return null;
  let body = prompt.slice(markerIdx + WEB_RESEARCH_MARKER.length);
  for (const end of [
    "\n\nThe player attached",
    "\n\nPlayer's new question (reply",
    "\n\nPlayer's new question:",
  ]) {
    const idx = body.indexOf(end);
    if (idx >= 0) body = body.slice(0, idx);
  }
  return body.trim();
}

function enrichSourcePreviews(
  sources: PipelineSourceRow[],
  fillers: PipelineSourceRow[][],
): PipelineSourceRow[] {
  if (!sources.length) {
    for (const filler of fillers) {
      if (filler.length) return filler;
    }
    return [];
  }

  const byUrl = new Map<string, PipelineSourceRow>();
  const byTitle = new Map<string, PipelineSourceRow>();
  const flat = fillers.flat();
  for (const row of flat) {
    if (row.url) byUrl.set(row.url, row);
    byTitle.set(normalizeSourceTitle(row.title), row);
  }

  return sources.map((source, index) => {
    if (source.preview) return source;
    const fromUrl = source.url ? byUrl.get(source.url) : undefined;
    const fromTitle = byTitle.get(normalizeSourceTitle(source.title));
    const fromIndex = flat[index];
    const preview = fromUrl?.preview ?? fromTitle?.preview ?? fromIndex?.preview;
    return preview ? { ...source, preview } : source;
  });
}

function parseRerank(events: TraceEventRow[]): { rerank?: PipelineRerank; start?: TraceEventRow } {
  const start = events.find((e) => e.event_type === "rag_rerank_start");
  const ok = events.find((e) => e.event_type === "rag_rerank_ok");
  const err = events.filter((e) => e.event_type === "rag_rerank_error").at(-1);
  if (!start && !ok && !err) return {};

  if (ok) {
    const m = meta(ok);
    return {
      start,
      rerank: {
        status: "ok",
        provider: metaString(m, "provider") ?? "cohere",
        model: metaString(m, "model"),
        topScore: metaNumber(m, "topScore"),
        relevant: metaBool(m, "relevant"),
        message: ok.message,
        latencyMs: ok.latency_ms,
      },
    };
  }
  if (err) {
    const m = meta(err);
    return {
      start,
      rerank: {
        status: "error",
        provider: metaString(m, "provider") ?? "cohere",
        model: metaString(m, "model"),
        message: err.message,
        latencyMs: err.latency_ms,
      },
    };
  }
  const m = meta(start!);
  return {
    start,
    rerank: {
      status: "skipped",
      provider: metaString(m, "provider") ?? "cohere",
      model: metaString(m, "model"),
      message: start!.message,
    },
  };
}

export function buildActivityPipeline(
  traceEvents: TraceEventRow[] | undefined,
  technical: Record<string, unknown> | undefined,
  llmCalls?: Array<{ kind: string; prompt: string; input_tokens?: number | null; output_tokens?: number | null; model?: string }>,
): ActivityPipeline | undefined {
  const events = traceEvents ?? [];
  const tech = technical ?? {};
  if (!events.length && !Object.keys(tech).length) return undefined;

  const pipelineType =
    (typeof tech.pipeline_type === "string" ? tech.pipeline_type : undefined) ||
    metaString(meta(events.find((e) => e.event_type === "retrieval_complete") ?? ({} as TraceEventRow)), "pipelineType");

  const searchTopic = events
    .filter((e) => e.event_type === "rewrite_complete")
    .map((e) => metaString(meta(e), "searchTopic"))
    .find(Boolean);

  const tavilyQueries = events
    .filter((e) => e.event_type === "tavily_search_start")
    .map((e) => metaString(meta(e), "query"))
    .filter((q): q is string => Boolean(q));

  const queries = [...new Set([searchTopic, ...tavilyQueries].filter(Boolean) as string[])];

  const retrieval = events.find((e) => e.event_type === "retrieval_complete");
  const retrievalMeta = retrieval ? meta(retrieval) : {};
  const ragScore = events.find((e) => e.event_type === "rag_similarity_score");
  const ragMeta = ragScore ? meta(ragScore) : {};

  let webSources = parseSourceRows(retrievalMeta.webSources);
  let ragChunks = parseSourceRows(retrievalMeta.ragChunks);

  const storedSources = parseSourceRows(tech.sources);
  const summarizePrompt = llmCalls?.find((call) => call.kind === "summarize")?.prompt ?? "";
  const promptSnippets = extractSnippetsFromSummarizePrompt(summarizePrompt);

  if (!webSources.length && !ragChunks.length && storedSources.length) {
    if (pipelineType === "rag") ragChunks = storedSources;
    else webSources = storedSources;
  } else if (!webSources.length && storedSources.length && pipelineType !== "rag") {
    webSources = storedSources;
  } else if (!webSources.length && storedSources.length && pipelineType === "rag") {
    ragChunks = storedSources;
  }

  const storedWeb = storedSources.filter((row) => !row.similarity);
  const storedRag = storedSources.filter((row) => row.similarity != null || pipelineType === "rag");
  webSources = enrichSourcePreviews(webSources, [
    parseSourceRows(retrievalMeta.webSources),
    storedWeb,
    promptSnippets.web,
  ]);
  ragChunks = enrichSourcePreviews(ragChunks, [
    parseSourceRows(retrievalMeta.ragChunks),
    parseSourceRows(ragMeta.chunks),
    storedRag,
    promptSnippets.preferred,
  ]);

  const ragDb = events.find((e) => e.event_type === "rag_db_check");
  const embedQuery =
    events
      .filter((e) => e.event_type === "embed_query_start")
      .map((e) => metaString(meta(e), "query"))
      .find(Boolean) ?? queries[0];

  const { rerank, start: rerankStart } = parseRerank(events);
  const cohereEvents = events.filter((event) => event.event_type.startsWith("rag_rerank"));
  const hasCohere = cohereEvents.length > 0;
  const hasRag =
    pipelineType === "rag" ||
    pipelineType === "rag_supplemented" ||
    pipelineType === "fallback_web" ||
    ragChunks.length > 0 ||
    Boolean(ragScore) ||
    Boolean(rerank);

  const hasWeb =
    pipelineType === "web" ||
    pipelineType === "web_skip_guide" ||
    pipelineType === "rag_supplemented" ||
    pipelineType === "fallback_web" ||
    webSources.length > 0 ||
    events.some((e) => e.event_type.startsWith("tavily_search") || e.event_type.startsWith("web_search"));

  const memorySummarize = events.find((e) => e.event_type === "memory_summarize_complete");
  const memoryRefresh = events.find((e) => e.event_type === "memory_refresh_complete");
  const isMemory = Boolean(events.find((e) => e.event_type === "memory_refresh_start"));

  const pipeline: ActivityPipeline = {
    pipelineType: isMemory ? "memory" : pipelineType,
    apiSpend: buildApiSpend(events, llmCalls),
    latencies: {
      rewrite_ms: typeof tech.rewrite_latency_ms === "number" ? tech.rewrite_latency_ms : null,
      retrieval_ms: typeof tech.retrieval_latency_ms === "number" ? tech.retrieval_latency_ms : null,
      generation_ms:
        typeof tech.generation_latency_ms === "number"
          ? tech.generation_latency_ms
          : memorySummarize?.latency_ms ?? memoryRefresh?.latency_ms ?? null,
    },
    technicalExtras: {
      preferred_urls: tech.preferred_urls,
      error_message: tech.error_message,
      trace_event_count: tech.trace_event_count,
      trace_latency_ms: tech.trace_latency_ms,
    },
  };

  if (hasWeb) {
    pipeline.webSearch = {
      searchTopic,
      queries,
      sourceCount: metaNumber(retrievalMeta, "sourceCount") ?? webSources.length,
      latencyMs: events.find((e) => e.event_type === "web_search_complete")?.latency_ms ?? retrieval?.latency_ms,
      sources: webSources,
    };
  }

  if (hasRag) {
    pipeline.rag = {
      hit: metaBool(ragMeta, "hit"),
      topSimilarity: metaNumber(ragMeta, "topSimilarity"),
      threshold: metaNumber(ragMeta, "threshold"),
      reranked: metaBool(ragMeta, "reranked"),
      matchCount: metaNumber(meta(ragDb ?? ({} as TraceEventRow)), "matchCount"),
      embedQuery,
      rerank,
      chunks: ragChunks,
    };
  }

  if (hasCohere && rerank) {
    pipeline.cohere = {
      ...rerank,
      chunkCount: metaNumber(meta(rerankStart ?? ({} as TraceEventRow)), "chunkCount"),
      events: cohereEvents,
    };
  }

  pipeline.apiCost = buildApiCost(pipeline.apiSpend, llmCalls);

  return pipeline;
}
