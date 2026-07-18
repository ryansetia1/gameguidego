import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { logLlmCallToDb, type LlmDbLogEntry } from "@/lib/llm-db-log";

// Best-effort log of each model call (file + optional Supabase). Never blocks answers.
const FILE_ENABLED =
  process.env.NODE_ENV !== "production" || process.env.LLM_LOG === "1";
const LOG_PATH =
  process.env.LLM_LOG_PATH || path.join(process.cwd(), "llm-log.json");
// One turn = rewrite + summarize, so 10 ≈ 5 turns.
const MAX_ENTRIES = 10;

export type LlmLogEntry = {
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

export function logLlmCall(entry: LlmLogEntry): void {
  if (FILE_ENABLED) {
    try {
      let log: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(LOG_PATH, "utf8"));
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
      writeFileSync(LOG_PATH, JSON.stringify(log.slice(-MAX_ENTRIES), null, 2));
    } catch {
      // Best-effort: never let logging break a request.
    }
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
  };
  void logLlmCallToDb(dbEntry);
}
