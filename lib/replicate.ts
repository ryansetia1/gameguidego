import Replicate from "replicate";

import { parseSummary } from "@/lib/highlights.js";
import { logLlmCall } from "@/lib/llm-log";
import {
  REWRITE_INSTRUCTION,
  SYSTEM_INSTRUCTION,
  buildPrompt,
  buildRewritePrompt,
} from "@/lib/prompt";
import {
  SPOILER_CENSOR_INSTRUCTION,
  buildSpoilerCensorPrompt,
} from "@/lib/spoiler-prefs.js";
import type { SearchResult } from "@/lib/tavily";

type SpoilerPrefs = {
  major: boolean;
};

const DEFAULT_MODEL = "google/gemini-2.5-flash";

export type Turn = {
  role: "user" | "assistant";
  content: string;
};

export type Highlight = {
  kind: "item" | "recruit" | "sidequest" | "tip" | "warning";
  title: string;
  detail: string;
};

export type SpoilerReveal = {
  detail: string;
  title?: string;
};

export type SummaryResult = {
  answer: string;
  highlights: Highlight[];
  spoilers: SpoilerReveal[];
  // Model self-flag (spoilers OFF only): its answer may brush a major reveal.
  spoilerRisk: boolean;
};

type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

function resolveModel(): ModelName | null {
  const model = process.env.REPLICATE_MODEL || DEFAULT_MODEL;
  if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) return null;
  return model as ModelName;
}

// Combine the per-call timeout with an optional caller signal (client Stop /
// disconnect), so aborting the request also cancels the Replicate prediction.
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function readText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.filter((part) => typeof part === "string").join("");
  }
  return "";
}

type PredictionMetrics = {
  metrics?: { predict_time?: number; total_time?: number };
};

type RunModelResult = {
  output: string;
  durationMs: number;
  predictTimeMs: number | null;
};

/** Run a Replicate model and capture wall-clock + predict_time metrics. */
async function runModel(
  replicate: Replicate,
  model: ModelName,
  input: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunModelResult> {
  const started = Date.now();
  let metrics: PredictionMetrics["metrics"];
  const raw = await replicate.run(
    model,
    {
      input,
      signal: withTimeout(timeoutMs, signal),
    },
    (prediction: PredictionMetrics) => {
      metrics = prediction.metrics;
    },
  );
  const predictTimeMs =
    metrics?.predict_time != null ? Math.round(metrics.predict_time * 1000) : null;
  return {
    output: readText(raw),
    durationMs: Date.now() - started,
    predictTimeMs,
  };
}

/**
 * Condense a (possibly context-dependent) question into a standalone English
 * search query. Best-effort: on any failure it falls back to the raw question,
 * so search still runs.
 */
export async function resolveQuestion(input: {
  question: string;
  history?: Turn[];
  signal?: AbortSignal;
}): Promise<string> {
  const token = process.env.REPLICATE_API_TOKEN;
  const model = resolveModel();
  if (!token || !model) return input.question;

  try {
    const replicate = new Replicate({ auth: token });
    const prompt = buildRewritePrompt(input);
    const { output: rawOutput, durationMs, predictTimeMs } = await runModel(
      replicate,
      model,
      {
        prompt,
        system_instruction: REWRITE_INSTRUCTION,
        temperature: 0.2,
        max_output_tokens: 200,
        thinking_budget: 0,
      },
      15_000,
      input.signal,
    );

    logLlmCall({
      kind: "rewrite",
      model,
      system: REWRITE_INSTRUCTION,
      prompt,
      response: rawOutput,
      durationMs,
      predictTimeMs,
    });
    const rewritten = rawOutput
      .replace(/\s+/g, " ")
      .replace(/^["']|["']$/g, "")
      .trim()
      .slice(0, 200);
    return rewritten || input.question;
  } catch (error) {
    console.error("Query rewrite failed, using raw question:", error);
    return input.question;
  }
}

export type SummarizeInput = {
  game?: string;
  platform?: string;
  question: string;
  sources: SearchResult[];
  history?: Turn[];
  images?: string[];
  spoilerPrefs?: SpoilerPrefs;
  playerName?: string;
  signal?: AbortSignal;
};

export async function summarize(input: SummarizeInput): Promise<SummaryResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not configured");
  }

  const model = resolveModel();
  if (!model) {
    throw new Error("REPLICATE_MODEL must use owner/name format");
  }

  const images = (input.images ?? []).filter((url) => typeof url === "string" && url);
  const replicate = new Replicate({ auth: token });
  const prompt = buildPrompt({ ...input, imageCount: images.length });
  const { output: rawOutput, durationMs, predictTimeMs } = await runModel(
    replicate,
    model,
    {
      prompt,
      system_instruction: SYSTEM_INSTRUCTION,
      ...(images.length ? { images } : {}),
      temperature: 0.35,
      max_output_tokens: 4096,
      thinking_budget: 0,
    },
    50_000,
    input.signal,
  );

  const trimmed = rawOutput.trim();
  logLlmCall({
    kind: "summarize",
    model,
    system: SYSTEM_INSTRUCTION,
    prompt,
    response: trimmed,
    durationMs,
    predictTimeMs,
    game: input.game,
    platform: input.platform,
  });
  const parsed = parseSummary(trimmed);
  if (!parsed.answer) {
    throw new Error("Replicate returned an empty response");
  }

  return parsed;
}

/**
 * Second-pass spoiler safety net. Only call this when spoilers are OFF and the
 * model self-flagged spoilerRisk. Rewrites answer + highlights to strip major
 * reveals while keeping guidance. Best-effort: returns null on any failure, so
 * the caller keeps the original (prompt-guarded) answer rather than blanking it.
 * ponytail: fails OPEN — spoilerRisk over-triggers, and the original was already
 * written under the anti-spoiler prompt; upgrade to fail-closed only if the
 * censor proves it catches real leaks the primary prompt misses.
 */
export async function censorSpoilers(input: {
  answer: string;
  highlights: Highlight[];
  signal?: AbortSignal;
}): Promise<{ answer: string; highlights: Highlight[] } | null> {
  const token = process.env.REPLICATE_API_TOKEN;
  const model = resolveModel();
  if (!token || !model) return null;

  try {
    const replicate = new Replicate({ auth: token });
    const prompt = buildSpoilerCensorPrompt(input);
    const { output: rawOutput, durationMs, predictTimeMs } = await runModel(
      replicate,
      model,
      {
        prompt,
        system_instruction: SPOILER_CENSOR_INSTRUCTION,
        temperature: 0.2,
        max_output_tokens: 4096,
        thinking_budget: 0,
      },
      30_000,
      input.signal,
    );

    const trimmed = rawOutput.trim();
    logLlmCall({
      kind: "censor",
      model,
      system: SPOILER_CENSOR_INSTRUCTION,
      prompt,
      response: trimmed,
      durationMs,
      predictTimeMs,
    });
    const parsed = parseSummary(trimmed);
    if (!parsed.answer) return null;
    return { answer: parsed.answer, highlights: parsed.highlights };
  } catch (error) {
    console.error("Spoiler censor failed, using original answer:", error);
    return null;
  }
}
