import { getServerClient } from "@/lib/supabase-server";
import { getTraceId } from "@/lib/trace";

// Log when Supabase vars are set. Set LLM_DB_LOG=0 to disable (e.g. local tests).
const ENABLED = process.env.LLM_DB_LOG !== "0";

export type LlmDbLogEntry = {
  kind: "rewrite" | "summarize" | "censor" | "embed_index" | "embed_query" | "memory_summarize";
  model: string;
  system: string;
  prompt: string;
  response: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  predictTimeMs?: number | null;
  game?: string;
  platform?: string;
  userId?: string | null;
  traceId?: string | null;
};

function coerceInt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** Best-effort insert into `public.llm_calls`. Never blocks the answer path. */
export async function logLlmCallToDb(entry: LlmDbLogEntry): Promise<void> {
  if (!ENABLED) return;
  const supabase = getServerClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("llm_calls").insert({
      kind: entry.kind,
      model: entry.model.slice(0, 120),
      trace_id: entry.traceId ?? getTraceId() ?? null,
      system_instruction: entry.system.slice(0, 100_000),
      prompt: entry.prompt.slice(0, 100_000),
      response: entry.response.slice(0, 100_000),
      input_tokens: coerceInt(entry.inputTokens),
      output_tokens: coerceInt(entry.outputTokens),
      duration_ms: coerceInt(entry.durationMs),
      predict_time_ms: coerceInt(entry.predictTimeMs),
      game: entry.game?.slice(0, 120) ?? null,
      platform: entry.platform?.slice(0, 80) ?? null,
      user_id: entry.userId ?? null,
    });
    if (error) {
      console.error("llm_calls insert failed:", error.message, error.code);
    }
  } catch (caught) {
    console.error("llm_calls insert error:", caught);
  }
}
