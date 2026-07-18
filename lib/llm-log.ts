import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Best-effort dev log of the exact system instruction + prompt + raw response for
// each model call, so we can inspect why an answer drifted. Keeps the last few
// turns only. Enabled in dev automatically; in production only when LLM_LOG=1
// (serverless filesystems are usually read-only, so writes just no-op there).
const ENABLED =
  process.env.NODE_ENV !== "production" || process.env.LLM_LOG === "1";
const LOG_PATH =
  process.env.LLM_LOG_PATH || path.join(process.cwd(), "llm-log.json");
// One turn = a resolveQuestion (rewrite) + a summarize call, so 10 ≈ 5 turns.
const MAX_ENTRIES = 10;

type LlmLogEntry = {
  kind: "rewrite" | "summarize" | "censor";
  model: string;
  system: string;
  prompt: string;
  response: string;
};

export function logLlmCall(entry: LlmLogEntry): void {
  if (!ENABLED) return;
  try {
    let log: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(LOG_PATH, "utf8"));
      if (Array.isArray(parsed)) log = parsed;
    } catch {
      // No file yet or unreadable — start fresh.
    }
    log.push({ at: new Date().toISOString(), ...entry });
    writeFileSync(LOG_PATH, JSON.stringify(log.slice(-MAX_ENTRIES), null, 2));
  } catch {
    // Best-effort: never let logging break a request.
  }
}
