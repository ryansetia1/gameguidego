import Replicate from "replicate";

import { logLlmCall } from "@/lib/llm-log";
import {
  coercePlayerStyle,
  MEMORY_GAME_NOTE_CAP,
  MEMORY_STYLE_NOTE_CAP,
  normGameKey,
  type PlayerStyleShape,
} from "@/lib/player-memory.js";

const DEFAULT_MODEL = "google/gemini-2.5-flash";

type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

type RunModelResult = {
  output: string;
  durationMs: number;
  predictTimeMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

function resolveModel(): ModelName | null {
  const model = process.env.REPLICATE_MODEL || DEFAULT_MODEL;
  if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) return null;
  return model as ModelName;
}

let replicateInstance: Replicate | null = null;

function getReplicate(): Replicate | null {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return null;
  if (!replicateInstance) replicateInstance = new Replicate({ auth: token });
  return replicateInstance;
}

const MEMORY_SUMMARIZE_INSTRUCTION = `You update a player's style memory for a video game guide app.
Read the existing memory card and new user messages, then output ONLY a JSON object:
{"style":{"answerLength":"short"|"medium"|"detailed","tone":"casual"|"direct","language":"id"|"en"|"mixed","detailLevel":"steps"|"context"|"minimal","notes":["..."]},"games":[{"gameKey":"normalized slug","platform":"...","progress":"...","notes":["..."]}]}

Rules:
- Infer how the player prefers answers (length, tone, language, detail). Use notes for extra bullets (max 5).
- games: only titles with clear signals in the new messages; merge with existing game notes; max 5 games.
- Drop stale or contradicted items. Do not invent progress the messages do not support.
- Omit unknown style fields instead of guessing.
- No markdown fences, no text outside JSON.`;

type DeltaMessage = { game: string; platform: string; content: string; at: string };

type ExistingGameRow = {
  game_key: string;
  platform: string;
  progress: string | null;
  notes: string[];
};

type SummarizeInput = {
  userId: string;
  existingStyle: PlayerStyleShape;
  existingGames: ExistingGameRow[];
  deltaMessages: DeltaMessage[];
};

export type MemorySummaryResult = {
  style: PlayerStyleShape;
  games: Array<{
    gameKey: string;
    platform: string;
    progress?: string;
    notes: string[];
  }>;
};

function buildSummarizePrompt(input: SummarizeInput) {
  const existing = {
    style: input.existingStyle,
    games: input.existingGames.map((row) => ({
      gameKey: row.game_key,
      platform: row.platform,
      progress: row.progress ?? "",
      notes: row.notes ?? [],
    })),
  };
  const delta = input.deltaMessages.map((msg) => ({
    game: msg.game,
    platform: msg.platform,
    content: msg.content,
    at: msg.at,
  }));
  return `Existing memory:\n${JSON.stringify(existing)}\n\nNew user messages:\n${JSON.stringify(delta)}`;
}

function parseMemorySummary(raw: string): MemorySummaryResult | null {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const style = coercePlayerStyle(parsed.style);
    const games = Array.isArray(parsed.games)
      ? parsed.games.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          const gameKey =
            typeof record.gameKey === "string"
              ? normGameKey(record.gameKey)
              : typeof record.game === "string"
                ? normGameKey(record.game)
                : "";
          if (!gameKey) return [];
          const platform =
            typeof record.platform === "string" ? record.platform.slice(0, 40) : "";
          const progress =
            typeof record.progress === "string" ? record.progress.slice(0, 200) : undefined;
          const notes = Array.isArray(record.notes)
            ? record.notes
                .flatMap((n) => (typeof n === "string" ? [n.replace(/\s+/g, " ").trim()] : []))
                .filter(Boolean)
                .slice(0, MEMORY_GAME_NOTE_CAP)
            : [];
          return [{ gameKey, platform, progress, notes }];
        })
      : [];
    return { style, games: games.slice(0, MEMORY_GAME_NOTE_CAP) };
  } catch {
    return null;
  }
}

async function runMemoryModel(
  prompt: string,
  userId: string,
): Promise<RunModelResult | null> {
  const replicate = getReplicate();
  const model = resolveModel();
  if (!replicate || !model) return null;

  const started = Date.now();
  let metrics: { predict_time?: number } | undefined;
  let logs: string | undefined;

  try {
    const raw = await replicate.run(
      model,
      {
        input: {
          prompt,
          system_instruction: MEMORY_SUMMARIZE_INSTRUCTION,
          temperature: 0.2,
          max_output_tokens: 2048,
          thinking_budget: 0,
        },
        wait: { mode: "poll", interval: 500 },
      },
      (prediction: { metrics?: { predict_time?: number }; logs?: string }) => {
        metrics = prediction.metrics;
        if (prediction.logs) logs = prediction.logs;
      },
    );

    const output =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.map((chunk) => (typeof chunk === "string" ? chunk : "")).join("")
          : "";

    const predictTimeMs =
      metrics?.predict_time != null ? Math.round(metrics.predict_time * 1000) : null;
    const inputTokens = logs?.match(/Input token count:\s*(\d+)/i)?.[1];
    const outputTokens = logs?.match(/Output token count:\s*(\d+)/i)?.[1];

    return {
      output: output.trim(),
      durationMs: Date.now() - started,
      predictTimeMs,
      inputTokens: inputTokens ? Number(inputTokens) : null,
      outputTokens: outputTokens ? Number(outputTokens) : null,
    };
  } catch (error) {
    console.error("Player memory summarize failed:", error);
    return null;
  }
}

export async function summarizePlayerMemory(
  input: SummarizeInput,
): Promise<MemorySummaryResult | null> {
  const prompt = buildSummarizePrompt(input);
  const result = await runMemoryModel(prompt, input.userId);
  if (!result?.output) return null;

  const model = resolveModel() ?? "unknown";
  logLlmCall({
    kind: "memory_summarize",
    model,
    system: MEMORY_SUMMARIZE_INSTRUCTION,
    prompt,
    response: result.output,
    durationMs: result.durationMs,
    predictTimeMs: result.predictTimeMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    userId: input.userId,
  });

  return parseMemorySummary(result.output);
}
