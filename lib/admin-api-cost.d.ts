import type { ApiSpendKey, ApiSpendSummary } from "./admin-api-spend.js";
import type { TraceEventRow } from "./admin-traces";

export const API_COST_RATES: {
  readonly replicate_input_per_m: 0.3;
  readonly replicate_output_per_m: 2.5;
  readonly sumopod_embed_per_m: 0.13;
};

export type LlmCallCostInput = {
  kind: string;
  model?: string;
  prompt?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
};

export type ApiCostLine = {
  key: ApiSpendKey;
  label: string;
  count: number;
  costUsd: number | null;
  tokenNote?: string;
};

export type ApiCostSummary = {
  lines: ApiCostLine[];
  knownTotalUsd: number;
  complete: boolean;
};

export function embedTokensFromLlmPrompt(prompt: string | undefined): number | null;
export function formatTokenCount(tokens: number): string;
export function formatUsd(amount: number | null): string;
export function buildTraceApiCost(
  events: TraceEventRow[],
  llmCalls: LlmCallCostInput[],
): ApiCostSummary | undefined;
export function buildApiCost(
  spend: ApiSpendSummary | undefined,
  llmCalls: LlmCallCostInput[] | undefined,
): ApiCostSummary | undefined;
export function formatApiCostCompact(summary: ApiCostSummary): string;
export function mergeApiCostTotals(rows: Array<ApiCostSummary | undefined>): ApiCostSummary | undefined;
