export type ApiSpendKey =
  | "tavily"
  | "replicate"
  | "cohere"
  | "sumopod_embed"
  | "sumopod_resolve"
  | "sumopod_summarize";

export type ApiSpendLine = {
  key: ApiSpendKey;
  label: string;
  count: number;
};

export type ApiSpendSummary = {
  counts: Record<ApiSpendKey, number>;
  lines: ApiSpendLine[];
  total: number;
};

export function countApiSpendFromTrace(
  events: Array<{ event_type: string }>,
): Record<ApiSpendKey, number>;

export function countApiSpendFromLlm(calls: Array<{ kind: string }>): Record<ApiSpendKey, number>;

export function buildApiSpend(
  traceEvents: Array<{ event_type: string }> | undefined,
  llmCalls: Array<{ kind: string }> | undefined,
): ApiSpendSummary | undefined;

export function formatApiSpendCompact(summary: ApiSpendSummary): string;

export function mergeApiSpendTotals(
  rows: Array<ApiSpendSummary | undefined>,
): ApiSpendSummary | undefined;
