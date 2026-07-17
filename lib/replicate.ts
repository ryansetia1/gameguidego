import Replicate from "replicate";

import { buildPrompt } from "@/lib/prompt";
import type { SearchResult } from "@/lib/tavily";

const DEFAULT_MODEL = "meta/meta-llama-3-8b-instruct";

export type Turn = {
  role: "user" | "assistant";
  content: string;
};

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

  const model = process.env.REPLICATE_MODEL || DEFAULT_MODEL;
  if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) {
    throw new Error("REPLICATE_MODEL must use owner/name format");
  }

  const replicate = new Replicate({ auth: token });
  const output: unknown = await replicate.run(
    model as `${string}/${string}` | `${string}/${string}:${string}`,
    {
      input: {
        prompt: buildPrompt(input),
        prompt_template: "{prompt}",
        max_tokens: 700,
        temperature: 0.2,
      },
      signal: AbortSignal.timeout(50_000),
    },
  );

  const summary =
    typeof output === "string"
      ? output
      : Array.isArray(output)
        ? output.filter((part) => typeof part === "string").join("")
        : "";

  if (!summary.trim()) {
    throw new Error("Replicate returned an empty response");
  }

  return summary.trim();
}
