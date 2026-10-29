import { logLlmCall } from "@/lib/llm-log";

export type EmbedLogMeta = {
  purpose: "ingest" | "rag_query";
  game?: string;
  platform?: string;
  userId?: string | null;
  guideUrl?: string;
  bundleKey?: string;
};

function resolveEmbedModel(): string {
  return process.env.EMBED_MODEL || "text-embedding-3-large";
}

/** Best-effort embed audit log (file + llm_calls when Supabase is set). */
export function logEmbedCall(input: {
  kind: "embed_index" | "embed_query";
  /** Model tag that produced the vectors (defaults to the Sumopod env model). */
  model?: string;
  textCount: number;
  durationMs: number;
  sampleText?: string;
  totalChars?: number;
  inputTokens?: number | null;
  cached?: boolean;
  meta?: EmbedLogMeta;
}): void {
  const meta = input.meta ?? { purpose: input.kind === "embed_query" ? "rag_query" : "ingest" };
  const prompt = JSON.stringify({
    purpose: meta.purpose,
    model: input.model ?? null,
    textCount: input.textCount,
    guideUrl: meta.guideUrl ?? null,
    bundleKey: meta.bundleKey ?? null,
    cached: Boolean(input.cached),
    inputTokens: input.inputTokens ?? null,
    totalChars: input.totalChars ?? null,
    sample: input.sampleText?.slice(0, 400) ?? "",
  });

  logLlmCall({
    kind: input.kind,
    model: input.model && input.model !== "sumopod" ? input.model : resolveEmbedModel(),
    system: meta.purpose,
    prompt,
    response: JSON.stringify({
      vectors: input.textCount,
      dim: 1024,
      cached: Boolean(input.cached),
      inputTokens: input.inputTokens ?? null,
    }),
    inputTokens: input.inputTokens ?? (input.cached ? 0 : null),
    outputTokens: 0,
    durationMs: input.durationMs,
    game: meta.game,
    platform: meta.platform,
    userId: meta.userId,
  });
}
