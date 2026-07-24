// @ts-nocheck
/** @typedef {'tavily' | 'replicate' | 'cohere' | 'sumopod_embed' | 'sumopod_resolve' | 'sumopod_summarize'} ApiSpendKey */

/** @typedef {{ key: ApiSpendKey; label: string; count: number }} ApiSpendLine */

/** @typedef {{ counts: Record<ApiSpendKey, number>; lines: ApiSpendLine[]; total: number }} ApiSpendSummary */

const REPLICATE_KINDS = new Set(["rewrite", "summarize", "censor", "memory_summarize"]);

/** @type {Record<ApiSpendKey, string>} */
const SPEND_LABELS = {
  tavily: "Tavily",
  replicate: "Replicate",
  cohere: "Cohere",
  sumopod_embed: "Sumopod embed",
  sumopod_resolve: "Sumopod resolve",
  sumopod_summarize: "Sumopod summarize",
};

/** @type {ApiSpendKey[]} */
const SPEND_KEYS = [
  "tavily",
  "replicate",
  "cohere",
  "sumopod_embed",
  "sumopod_resolve",
  "sumopod_summarize",
];

/** @returns {Record<ApiSpendKey, number>} */
function emptyCounts() {
  return {
    tavily: 0,
    replicate: 0,
    cohere: 0,
    sumopod_embed: 0,
    sumopod_resolve: 0,
    sumopod_summarize: 0,
  };
}

/** @param {string} kind @returns {ApiSpendKey | null} */
function sumopodSpendKey(kind) {
  if (kind === "embed_index" || kind === "embed_query") return "sumopod_embed";
  return null;
}

/** @param {Record<ApiSpendKey, number>} counts @returns {ApiSpendLine[]} */
function linesFromCounts(counts) {
  return SPEND_KEYS.map((key) => ({ key, label: SPEND_LABELS[key], count: counts[key] })).filter(
    (line) => line.count > 0,
  );
}

/** @param {Array<{ event_type: string }>} events @returns {Record<ApiSpendKey, number>} */
export function countApiSpendFromTrace(events) {
  const counts = emptyCounts();
  let embedQueryBillable = false;

  for (const event of events) {
    switch (event.event_type) {
      case "tavily_search_start":
      case "discovery_search_query":
      case "tavily_extract_start":
      case "discovery_extract_start":
        counts.tavily += 1;
        break;
      case "rag_rerank_start":
        counts.cohere += 1;
        break;
      case "embed_query_start":
        embedQueryBillable = true;
        break;
      case "embed_query_cache_hit":
        embedQueryBillable = false;
        break;
      case "embed_query_end":
        if (embedQueryBillable) counts.sumopod_embed += 1;
        embedQueryBillable = false;
        break;
      case "embed_texts_start":
        counts.sumopod_embed += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

/** @param {Array<{ kind: string }>} calls @returns {Record<ApiSpendKey, number>} */
export function countApiSpendFromLlm(calls) {
  const counts = emptyCounts();
  for (const call of calls) {
    if (REPLICATE_KINDS.has(call.kind)) counts.replicate += 1;
    const sumopodKey = sumopodSpendKey(call.kind);
    if (sumopodKey) counts[sumopodKey] += 1;
  }
  return counts;
}

/**
 * @param {Array<{ event_type: string }> | undefined} traceEvents
 * @param {Array<{ kind: string }> | undefined} llmCalls
 * @returns {ApiSpendSummary | undefined}
 */
export function buildApiSpend(traceEvents, llmCalls) {
  const fromTrace = countApiSpendFromTrace(traceEvents ?? []);
  const fromLlm = countApiSpendFromLlm(llmCalls ?? []);

  const counts = emptyCounts();
  counts.tavily = fromTrace.tavily;
  counts.cohere = fromTrace.cohere;
  counts.replicate = fromLlm.replicate;
  counts.sumopod_embed = fromLlm.sumopod_embed > 0 ? fromLlm.sumopod_embed : fromTrace.sumopod_embed;
  counts.sumopod_resolve = fromLlm.sumopod_resolve;
  counts.sumopod_summarize = fromLlm.sumopod_summarize;

  const lines = linesFromCounts(counts);
  if (!lines.length) return undefined;

  return {
    counts,
    lines,
    total: lines.reduce((sum, line) => sum + line.count, 0),
  };
}

/** @param {ApiSpendSummary} summary @returns {string} */
export function formatApiSpendCompact(summary) {
  return summary.lines.map((line) => `${line.label.toLowerCase()}: ${line.count}`).join(" · ");
}

/**
 * @param {Array<ApiSpendSummary | undefined>} rows
 * @returns {ApiSpendSummary | undefined}
 */
export function mergeApiSpendTotals(rows) {
  const counts = emptyCounts();
  for (const row of rows) {
    if (!row) continue;
    for (const key of SPEND_KEYS) {
      counts[key] += row.counts[key];
    }
  }
  const lines = linesFromCounts(counts);
  if (!lines.length) return undefined;
  return {
    counts,
    lines,
    total: lines.reduce((sum, line) => sum + line.count, 0),
  };
}
