// @ts-nocheck
import { buildApiSpend } from "./admin-api-spend.js";

/** USD per 1M tokens — update when provider pricing changes. */
export const API_COST_RATES = {
  replicate_input_per_m: 0.3,
  replicate_output_per_m: 2.5,
  sumopod_embed_per_m: 0.13,
};

function roundUsd(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function tokensFromUsd(tokens, perMillion) {
  return roundUsd((tokens * perMillion) / 1_000_000);
}

function replicateCost(inputTokens, outputTokens) {
  return roundUsd(
    tokensFromUsd(inputTokens, API_COST_RATES.replicate_input_per_m) +
      tokensFromUsd(outputTokens, API_COST_RATES.replicate_output_per_m),
  );
}

function sumopodEmbedCost(inputTokens) {
  return tokensFromUsd(inputTokens, API_COST_RATES.sumopod_embed_per_m);
}

/** @param {string | undefined} prompt @returns {number | null} */
export function embedTokensFromLlmPrompt(prompt) {
  if (!prompt) return null;
  try {
    const parsed = JSON.parse(prompt);
    if (parsed.cached === true) return 0;
    if (typeof parsed.inputTokens === "number" && Number.isFinite(parsed.inputTokens)) {
      return Math.max(0, Math.round(parsed.inputTokens));
    }
    if (typeof parsed.totalChars === "number" && parsed.totalChars > 0) {
      return Math.ceil(parsed.totalChars / 4);
    }
    const textCount = typeof parsed.textCount === "number" ? parsed.textCount : 0;
    const sample = typeof parsed.sample === "string" ? parsed.sample : "";
    if (textCount > 0 && sample.length > 0) {
      return Math.ceil((sample.length * textCount) / 4);
    }
  } catch {
    // not JSON
  }
  return null;
}

/** @param {number | null} input @param {number | null} output @returns {string | undefined} */
function formatTokenNote(input, output) {
  const parts = [];
  if (input != null && input > 0) parts.push(`${formatTokenCount(input)} in`);
  if (output != null && output > 0) parts.push(`${formatTokenCount(output)} out`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** @param {number} tokens @returns {string} */
export function formatTokenCount(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/** @param {number | null} amount @returns {string} */
export function formatUsd(amount) {
  if (amount == null) return "—";
  return `$${amount.toFixed(3)}`;
}

/** @param {Array<{ kind: string; input_tokens?: number | null; output_tokens?: number | null }>} calls */
function costFromReplicateCalls(calls) {
  const replicateCalls = calls.filter((call) =>
    ["rewrite", "summarize", "censor", "memory_summarize", "visual_query"].includes(call.kind),
  );
  if (!replicateCalls.length) return { costUsd: null };

  let inputTotal = 0;
  let outputTotal = 0;
  let hasAll = true;
  for (const call of replicateCalls) {
    const input = call.input_tokens;
    const output = call.output_tokens;
    if (input == null || output == null) {
      hasAll = false;
      continue;
    }
    inputTotal += input;
    outputTotal += output;
  }

  if (!hasAll || (inputTotal === 0 && outputTotal === 0)) {
    return { costUsd: null };
  }

  return {
    costUsd: replicateCost(inputTotal, outputTotal),
    tokenNote: formatTokenNote(inputTotal, outputTotal),
  };
}

/** @param {Array<{ kind: string; prompt?: string }>} calls */
function costFromSumopodEmbedCalls(calls) {
  const embedCalls = calls.filter((call) => call.kind === "embed_index" || call.kind === "embed_query");
  if (!embedCalls.length) return { costUsd: null, estimated: false };

  let tokenTotal = 0;
  let hasAny = false;
  let hasAll = true;
  let estimated = false;

  for (const call of embedCalls) {
    const tokens = embedTokensFromLlmPrompt(call.prompt);
    if (tokens == null) {
      hasAll = false;
      continue;
    }
    hasAny = true;
    tokenTotal += tokens;
    try {
      const parsed = JSON.parse(call.prompt ?? "{}");
      if (parsed.inputTokens == null && tokens > 0) estimated = true;
    } catch {
      estimated = true;
    }
  }

  if (!hasAny || !hasAll) return { costUsd: null, estimated };

  return {
    costUsd: sumopodEmbedCost(tokenTotal),
    tokenNote: `${formatTokenCount(tokenTotal)} in`,
    estimated,
  };
}

/** @param {Array<{ event_type: string }>} events @param {Array<{ kind: string; prompt?: string; input_tokens?: number | null; output_tokens?: number | null }>} llmCalls */
export function buildTraceApiCost(events, llmCalls) {
  return buildApiCost(buildApiSpend(events, llmCalls), llmCalls);
}

/** @param {import("./admin-api-spend.js").ApiSpendSummary | undefined} spend @param {Array<{ kind: string; prompt?: string; input_tokens?: number | null; output_tokens?: number | null }> | undefined} llmCalls */
export function buildApiCost(spend, llmCalls) {
  if (!spend?.lines.length) return undefined;

  const calls = llmCalls ?? [];
  const replicateCostInfo = costFromReplicateCalls(calls);
  const embedCostInfo = costFromSumopodEmbedCalls(calls);

  const lines = spend.lines.map((line) => {
    if (line.key === "replicate") {
      return {
        key: line.key,
        label: line.label,
        count: line.count,
        costUsd: replicateCostInfo.costUsd,
        tokenNote: replicateCostInfo.tokenNote,
      };
    }
    if (line.key === "sumopod_embed") {
      return {
        key: line.key,
        label: line.label,
        count: line.count,
        costUsd: embedCostInfo.costUsd,
        tokenNote: embedCostInfo.tokenNote,
      };
    }
    return {
      key: line.key,
      label: line.label,
      count: line.count,
      costUsd: null,
    };
  });

  const priced = lines.filter((line) => line.costUsd != null);
  if (!priced.length) return undefined;

  const knownTotalUsd = roundUsd(priced.reduce((sum, line) => sum + (line.costUsd ?? 0), 0));
  const complete = lines.every((line) => line.count === 0 || line.costUsd != null);

  return { lines, knownTotalUsd, complete };
}

/** @param {import("./admin-api-cost.js").ApiCostSummary} summary @returns {string} */
export function formatApiCostCompact(summary) {
  return summary.lines
    .filter((line) => line.costUsd != null)
    .map((line) => `${line.label.toLowerCase()}: ${formatUsd(line.costUsd)}`)
    .join(" · ");
}

/** @param {Array<import("./admin-api-cost.js").ApiCostSummary | undefined>} rows */
export function mergeApiCostTotals(rows) {
  const byKey = new Map();

  for (const row of rows) {
    if (!row) continue;
    for (const line of row.lines) {
      const prev = byKey.get(line.key);
      if (!prev) {
        byKey.set(line.key, { ...line });
        continue;
      }
      byKey.set(line.key, {
        ...prev,
        count: prev.count + line.count,
        costUsd:
          prev.costUsd != null && line.costUsd != null
            ? roundUsd(prev.costUsd + line.costUsd)
            : prev.costUsd ?? line.costUsd,
      });
    }
  }

  const lines = [...byKey.values()].filter((line) => line.count > 0);
  if (!lines.length) return undefined;

  const priced = lines.filter((line) => line.costUsd != null);
  return {
    lines,
    knownTotalUsd: roundUsd(priced.reduce((sum, line) => sum + (line.costUsd ?? 0), 0)),
    complete: lines.every((line) => line.costUsd != null),
  };
}
