import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { logLlmCallToDb, type LlmDbLogEntry } from "@/lib/llm-db-log";
import { getTraceId } from "@/lib/trace";

// Best-effort log of each model call (file + optional Supabase). Never blocks answers.
const FILE_ENABLED =
  process.env.NODE_ENV !== "production" || process.env.LLM_LOG === "1";
const LOG_PATH =
  process.env.LLM_LOG_PATH || (process.cwd() + "/llm-log.json");
// One turn = rewrite + summarize, so 10 ≈ 5 turns.
const MAX_ENTRIES = 10;

export type LlmLogEntry = {
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

export function logLlmCall(entry: LlmLogEntry): void {
  if (FILE_ENABLED) {
    // Fire-and-forget async write so we never block the event loop.
    void (async () => {
      try {
        let log: unknown[] = [];
        try {
          const raw = await readFile(LOG_PATH, "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) log = parsed;
        } catch {
          // No file yet or unreadable — start fresh.
        }
        log.push({
          at: new Date().toISOString(),
          ...entry,
          durationMs: entry.durationMs ?? null,
          predictTimeMs: entry.predictTimeMs ?? null,
          inputTokens: entry.inputTokens ?? null,
          outputTokens: entry.outputTokens ?? null,
        });
        await writeFile(LOG_PATH, JSON.stringify(log.slice(-MAX_ENTRIES), null, 2));
      } catch {
        // Best-effort: never let logging break a request.
      }
    })();
  }

  const dbEntry: LlmDbLogEntry = {
    kind: entry.kind,
    model: entry.model,
    system: entry.system,
    prompt: entry.prompt,
    response: entry.response,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    durationMs: entry.durationMs,
    predictTimeMs: entry.predictTimeMs,
    game: entry.game,
    platform: entry.platform,
    userId: entry.userId,
    traceId: entry.traceId ?? getTraceId() ?? null,
  };
  void logLlmCallToDb(dbEntry);
}
