import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Log when Supabase vars are set. Set LLM_DB_LOG=0 to disable (e.g. local tests).
const ENABLED =
  process.env.LLM_DB_LOG !== "0" && Boolean(url && anonKey);

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!ENABLED || !url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export type LlmDbLogEntry = {
  kind: "rewrite" | "summarize" | "censor";
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
};

function coerceInt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** Best-effort insert into `public.llm_calls`. Never blocks the answer path. */
export async function logLlmCallToDb(entry: LlmDbLogEntry): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("llm_calls").insert({
      kind: entry.kind,
      model: entry.model.slice(0, 120),
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
