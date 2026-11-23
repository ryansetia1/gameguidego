import type { ApiSpendKey, ApiSpendSummary } from "./admin-api-spend.js";
import type { TraceEventRow } from "./admin-traces";

export const API_COST_RATES: {
  readonly sumopod_embed_per_m: 0.13;
};

export const REPLICATE_LLM_KINDS: string[];

export type LlmCallCostInput = {
  kind: string;
  model?: string;
  system_instruction?: string;
  prompt?: string;
  response?: string;
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
export function llmCallTokens(
  call: LlmCallCostInput,
): { input: number; output: number; estimated: boolean } | null;
export function llmCallCostUsd(call: LlmCallCostInput): number | null;
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
