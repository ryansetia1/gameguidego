import { getServerClient } from "@/lib/supabase-server";

// Log when Supabase vars are set. Set LLM_DB_LOG=0 to disable (e.g. local tests).
const ENABLED = process.env.LLM_DB_LOG !== "0";

export type SolveLogSource = {
  title: string;
  url: string;
  score?: number;
  preview?: string;
  preferred?: boolean;
};

/** Crawled snippet + metadata for admin `solve_logs.sources` (client SSE stays title+url only). */
export function sourcesForSolveLog(
  sources: Array<{ title: string; url: string; content?: string; score?: number; preferred?: boolean }>,
): SolveLogSource[] {
  const seen = new Set<string>();
  return sources.flatMap((source) => {
    if (seen.has(source.url)) return [];
    seen.add(source.url);
    return [
      {
        title: source.title.replace(/\s*\(section \d+\)\s*$/i, ""),
        url: source.url,
        score: source.score,
        preview: (source.content ?? "").slice(0, 800),
        ...(source.preferred ? { preferred: true } : {}),
      },
    ];
  });
}

export type SolveJourneyEntry = {
  userId?: string | null;
  playerName?: string | null;
  game?: string | null;
  platform?: string | null;
  question: string;
  preferredUrls?: string[];
  pipelineType:
    | "rag"
    | "rag_supplemented"
    | "web"
    | "web_skip_guide"
    | "fallback_web"
    | "knowledge_only";
  rewriteLatencyMs?: number;
  retrievalLatencyMs?: number;
  generationLatencyMs?: number;
  totalLatencyMs?: number;
  status: "success" | "error";
  errorMessage?: string;
  answer?: string;
  sources?: SolveLogSource[];
  traceId?: string | null;
};

function coerceInt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** Best-effort insert into `public.solve_logs`. Never blocks the answer path. */
export async function logSolveJourneyToDb(entry: SolveJourneyEntry): Promise<void> {
  if (!ENABLED) return;
  const supabase = getServerClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("solve_logs").insert({
      user_id: entry.userId ?? null,
      player_name: entry.playerName?.slice(0, 32) ?? null,
      game: entry.game?.slice(0, 120) ?? null,
      platform: entry.platform?.slice(0, 80) ?? null,
      question: entry.question.slice(0, 5000),
      preferred_urls: entry.preferredUrls ?? [],
      pipeline_type: entry.pipelineType,
      rewrite_latency_ms: coerceInt(entry.rewriteLatencyMs),
      retrieval_latency_ms: coerceInt(entry.retrievalLatencyMs),
      generation_latency_ms: coerceInt(entry.generationLatencyMs),
      total_latency_ms: coerceInt(entry.totalLatencyMs),
      status: entry.status,
      error_message: entry.errorMessage?.slice(0, 5000) ?? null,
      answer: entry.answer?.slice(0, 50000) ?? null,
      sources: entry.sources ?? [],
      trace_id: entry.traceId ?? null,
    });
    if (error) {
      console.error("Failed to insert solve log:", error);
    }
  } catch (err) {
    console.error("Error inserting solve log:", err);
  }
}

export type IngestJourneyEntry = {
  userId?: string | null;
  playerName?: string | null;
  traceId?: string | null;
  game?: string | null;
  platform?: string | null;
  url: string;
  latencyMs?: number;
  status: "success" | "error";
  pagesIndexed?: number;
  pagesMissing?: number;
  hubWarning?: boolean;
  errorMessage?: string;
};

/** Best-effort insert into `public.ingest_logs`. Never blocks the ingest path. */
export async function logIngestJourneyToDb(entry: IngestJourneyEntry): Promise<void> {
  if (!ENABLED) return;
  const supabase = getServerClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("ingest_logs").insert({
      user_id: entry.userId ?? null,
      player_name: entry.playerName?.slice(0, 32) ?? null,
      trace_id: entry.traceId ?? null,
      game: entry.game?.slice(0, 120) ?? null,
      platform: entry.platform?.slice(0, 80) ?? null,
      url: entry.url.slice(0, 500),
      latency_ms: coerceInt(entry.latencyMs),
      status: entry.status,
      pages_indexed: coerceInt(entry.pagesIndexed),
      pages_missing: coerceInt(entry.pagesMissing),
      hub_warning: entry.hubWarning ?? false,
      error_message: entry.errorMessage?.slice(0, 5000) ?? null,
    });
    if (error) {
      console.error("Failed to insert ingest log:", error);
    }
  } catch (err) {
    console.error("Error inserting ingest log:", err);
  }
}
