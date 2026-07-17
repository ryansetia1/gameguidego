import Replicate from "replicate";

import {
  REWRITE_INSTRUCTION,
  SYSTEM_INSTRUCTION,
  buildPrompt,
  buildRewritePrompt,
} from "@/lib/prompt";
import type { SearchResult } from "@/lib/tavily";

const DEFAULT_MODEL = "google/gemini-2.5-flash";

export type Turn = {
  role: "user" | "assistant";
  content: string;
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
 * Condense a (possibly context-dependent) follow-up into a standalone English
 * search query. Best-effort: on any failure it falls back to the raw question,
 * so search still runs. Only worth calling when there is conversation history.
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
    const output: unknown = await replicate.run(model, {
      input: {
        prompt: buildRewritePrompt(input),
        system_instruction: REWRITE_INSTRUCTION,
        temperature: 0.2,
        // The query is short, but Flash needs token headroom even with thinking
        // off; too tight a cap (e.g. 60) comes back empty.
        max_output_tokens: 200,
        thinking_budget: 0,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const rewritten = readText(output)
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
};

export async function summarize(input: SummarizeInput): Promise<string> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN is not configured");
  }

  const model = resolveModel();
  if (!model) {
    throw new Error("REPLICATE_MODEL must use owner/name format");
  }

  const replicate = new Replicate({ auth: token });
  const output: unknown = await replicate.run(model, {
    input: {
      prompt: buildPrompt(input),
      // Gemini on Replicate: keep the persona/rules out of the prompt field.
      system_instruction: SYSTEM_INSTRUCTION,
      temperature: 0.35,
      max_output_tokens: 1200,
      // Flash is a reasoning model; disable thinking so the budget goes to the
      // visible answer and short replies don't come back empty.
      thinking_budget: 0,
    },
    signal: AbortSignal.timeout(50_000),
  });

  const summary = readText(output).trim();
  if (!summary) {
    throw new Error("Replicate returned an empty response");
  }

  return summary;
}
