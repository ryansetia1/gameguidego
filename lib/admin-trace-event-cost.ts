import {
  API_COST_RATES,
  embedTokensFromLlmPrompt,
  type LlmCallCostInput,
} from "./admin-api-cost.js";
import type { TraceEventRow } from "./admin-traces";

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function tokensFromUsd(tokens: number, perMillion: number): number {
  return roundUsd((tokens * perMillion) / 1_000_000);
}

function replicateCost(inputTokens: number, outputTokens: number): number {
  return roundUsd(
    tokensFromUsd(inputTokens, API_COST_RATES.replicate_input_per_m) +
      tokensFromUsd(outputTokens, API_COST_RATES.replicate_output_per_m),
  );
}

function sumopodEmbedCost(inputTokens: number): number {
  return tokensFromUsd(inputTokens, API_COST_RATES.sumopod_embed_per_m);
}

export function costFromSingleLlmCall(call: LlmCallCostInput): number | null {
  if (["rewrite", "summarize", "censor", "visual_query", "memory_summarize", "journal_synthesize"].includes(call.kind)) {
    const input = call.input_tokens;
    const output = call.output_tokens;
    if (input == null || output == null) return null;
    if (input === 0 && output === 0) return 0;
    return replicateCost(input, output);
  }
  if (call.kind === "embed_index" || call.kind === "embed_query") {
    const tokens = embedTokensFromLlmPrompt(call.prompt);
    if (tokens == null) return null;
    return sumopodEmbedCost(tokens);
  }
  return null;
}

function metaString(event: TraceEventRow, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function isReplicateSucceededEvent(event: TraceEventRow): boolean {
  if (event.event_type === "llm_phase") {
    return event.metadata?.phaseComplete === true;
  }
  if (event.event_type !== "replicate_status") return false;
  const status = metaString(event, "status");
  if (status === "succeeded") return true;
  if (status === "processing" || status === "starting") return false;
  return event.message.toLowerCase().includes("succeeded");
}

export function isSumopodCompleteEvent(event: TraceEventRow): boolean {
  if (event.event_type === "trace_phase" && event.metadata?.phaseType === "rag_embed") {
    return event.metadata?.phaseComplete === true;
  }
  if (event.event_type === "embed_query_end") return true;
  if (event.event_type !== "embed_texts_end") return false;
  const kind = metaString(event, "kind");
  return kind === "embed_index" || !kind;
}

export function isBillableCompleteEvent(event: TraceEventRow): boolean {
  return isReplicateSucceededEvent(event) || isSumopodCompleteEvent(event);
}

function isCachedEmbedCall(call: LlmCallCostInput): boolean {
  try {
    const parsed = JSON.parse(call.prompt ?? "{}") as Record<string, unknown>;
    if (parsed.cached === true) return true;
  } catch {
    // not JSON
  }
  const tokens = embedTokensFromLlmPrompt(call.prompt);
  return tokens === 0;
}

type TimedLlmCall = LlmCallCostInput & { created_at?: string };

function sortCalls<T extends TimedLlmCall>(calls: T[]): T[] {
  return [...calls].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
  );
}

/** Per-row cost (USD) on replicate succeeded + sumopod complete events only. */
export function buildTraceEventCostMap(
  events: TraceEventRow[],
  llmCalls: TimedLlmCall[],
): Map<number, number | null> {
  const map = new Map<number, number | null>();
  const replicateQueue = sortCalls(
    llmCalls.filter((call) => ["rewrite", "summarize", "censor", "visual_query", "memory_summarize", "journal_synthesize"].includes(call.kind)),
  );
  const embedQueryQueue = sortCalls(
    llmCalls.filter((call) => call.kind === "embed_query" && !isCachedEmbedCall(call)),
  );
  const embedIndexQueue = sortCalls(llmCalls.filter((call) => call.kind === "embed_index"));

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (isReplicateSucceededEvent(event)) {
      const call = replicateQueue.shift();
      map.set(index, call ? costFromSingleLlmCall(call) : null);
      continue;
    }
    if (isSumopodCompleteEvent(event) && (event.event_type === "embed_texts_end" || event.metadata?.phaseType === "rag_embed")) {
      const call = event.metadata?.phaseType === "rag_embed" ? embedQueryQueue.shift() : embedIndexQueue.shift();
      map.set(index, call ? costFromSingleLlmCall(call) : null);
    }
  }

  return map;
}

export function findTraceEventIndex(events: TraceEventRow[], event: TraceEventRow): number {
  return events.findIndex((row) => {
    if (row.created_at !== event.created_at || row.event_type !== event.event_type) return false;
    if (row.event_type === "replicate_status" || row.event_type === "llm_phase" || row.event_type === "trace_phase") {
      return true;
    }
    return row.message === event.message;
  });
}
