import Replicate from "replicate";

import { parseSummary } from "@/lib/highlights.js";
import { logLlmCall } from "@/lib/llm-log";
import {
  REWRITE_INSTRUCTION,
  SYSTEM_INSTRUCTION,
  buildPrompt,
  buildRewritePrompt,
} from "@/lib/prompt";
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
};

type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

function resolveModel(): ModelName | null {
  const model = process.env.REPLICATE_MODEL || DEFAULT_MODEL;
  if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) return null;
  return model as ModelName;
}

function readText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.filter((part) => typeof part === "string").join("");
  }
  return "";
}

/**
 * Condense a (possibly context-dependent) question into a standalone English
 * search query. Best-effort: on any failure it falls back to the raw question,
 * so search still runs.
 */
export async function resolveQuestion(input: {
  question: string;
  history?: Turn[];
}): Promise<string> {
  const token = process.env.REPLICATE_API_TOKEN;
  const model = resolveModel();
  if (!token || !model) return input.question;

  try {
    const replicate = new Replicate({ auth: token });
    const prompt = buildRewritePrompt(input);
    const output: unknown = await replicate.run(model, {
      input: {
        prompt,
        system_instruction: REWRITE_INSTRUCTION,
        temperature: 0.2,
        // The query is short, but Flash needs token headroom even with thinking
        // off; too tight a cap (e.g. 60) comes back empty.
        max_output_tokens: 200,
        thinking_budget: 0,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const rawOutput = readText(output);
    logLlmCall({
      kind: "rewrite",
      model,
      system: REWRITE_INSTRUCTION,
      prompt,
      response: rawOutput,
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
  const output: unknown = await replicate.run(model, {
    input: {
      prompt,
      // Gemini on Replicate: keep the persona/rules out of the prompt field.
      system_instruction: SYSTEM_INSTRUCTION,
      // Attached screenshots/photos as visual context (Gemini multimodal input).
      ...(images.length ? { images } : {}),
      temperature: 0.35,
      // Even with thinking_budget: 0, Flash on Replicate spends ~1k tokens of
      // reasoning overhead that counts against this cap, so it must stay
      // generous: at 1200 the visible answer got cut after ~100 tokens. This is
      // a ceiling, not a target — "keep it concise" in the system prompt drives
      // actual length. ponytail: bumped to 4096; raise toward Flash's 8192 max
      // if long walkthroughs still truncate.
      max_output_tokens: 4096,
      thinking_budget: 0,
    },
    signal: AbortSignal.timeout(50_000),
  });

  const rawOutput = readText(output).trim();
  logLlmCall({
    kind: "summarize",
    model,
    system: SYSTEM_INSTRUCTION,
    prompt,
    response: rawOutput,
  });
  const parsed = parseSummary(rawOutput);
  if (!parsed.answer) {
    throw new Error("Replicate returned an empty response");
  }

  return parsed;
}
