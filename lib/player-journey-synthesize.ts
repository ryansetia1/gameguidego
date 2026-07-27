import Replicate from "replicate";

import { logLlmCall } from "@/lib/llm-log";
import { JOURNAL_BODY_MAX } from "@/lib/player-journey.js";
import { getTraceId, logTraceEvent } from "@/lib/trace";

const DEFAULT_MODEL = "google/gemini-2.5-flash";

type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

type DeltaMessage = { game: string; platform: string; content: string; at: string };

type SynthesizeInput = {
  userId: string;
  game: string;
  platform: string;
  existingBody: string;
  deltaMessages: DeltaMessage[];
  traceId?: string;
};

const JOURNAL_SYNTHESIZE_INSTRUCTION = `You maintain a player's per-game progress journal for a video game guide app.
Merge the existing journal with new facts from recent chat messages. Output ONLY a JSON object:
{"body":"..."}

Rules:
- Write clear free-form prose: location, party, items, quests, builds, flags, and goals.
- When the delta updates a fact already in the journal (evolved, sold, moved, completed), rewrite that line in place. Do not keep stale duplicates.
- Prefer newer facts over older ones when they conflict.
- Only record facts supported by the existing journal or the new messages. Do not invent progress.
- When the journal nears the character cap, compact by pruning superseded or completed state instead of truncating mid-sentence.
- No markdown fences, no text outside JSON.`;

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

function buildPrompt(input: SynthesizeInput) {
  const delta = input.deltaMessages.map((msg) => ({
    content: msg.content,
    at: msg.at,
  }));
  return `Game: ${input.game}
Platform: ${input.platform || "unspecified"}

Existing journal:
${input.existingBody || "(empty)"}

New player messages:
${JSON.stringify(delta)}`;
}

function parseBody(raw: string): string | null {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (!parsed || typeof parsed.body !== "string") return null;
    return parsed.body.replace(/\r\n/g, "\n").trim().slice(0, JOURNAL_BODY_MAX);
  } catch {
    return null;
  }
}

export async function synthesizeJournalBody(
  input: SynthesizeInput,
): Promise<{ body: string; durationMs: number; inputTokens: number | null; outputTokens: number | null } | null> {
  const replicate = getReplicate();
  const model = resolveModel();
  if (!replicate || !model) return null;

  const prompt = buildPrompt(input);
  const started = Date.now();
  await logTraceEvent("journal_synthesize_start", "Synthesizing journal body", undefined, {
    model,
    deltaMessageCount: input.deltaMessages.length,
  });

  let output = "";
  let metrics: { predict_time?: number } | undefined;
  let logs: string | undefined;

  try {
    const raw = await replicate.run(
      model,
      {
        input: {
          prompt,
          system_instruction: JOURNAL_SYNTHESIZE_INSTRUCTION,
          temperature: 0.2,
          max_output_tokens: 8192,
          thinking_budget: 0,
        },
        wait: { mode: "poll", interval: 500 },
      },
      (prediction: { metrics?: { predict_time?: number }; logs?: string }) => {
        metrics = prediction.metrics;
        if (prediction.logs) logs = prediction.logs;
      },
    );
    if (typeof raw === "string") output = raw;
    else if (Array.isArray(raw)) {
      output = raw.filter((part) => typeof part === "string").join("");
    }
  } catch (error) {
    console.error("Journal synthesize failed:", error);
    await logTraceEvent("journal_update_error", "Journal synthesize failed", Date.now() - started, {
      step: "synthesize",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const durationMs = Date.now() - started;
  const predictTimeMs =
    metrics?.predict_time != null ? Math.round(metrics.predict_time * 1000) : null;
  const inputMatch = logs?.match(/Input token count:\s*(\d+)/i)?.[1];
  const outputMatch = logs?.match(/Output token count:\s*(\d+)/i)?.[1];
  const inputTokens = inputMatch ? Number(inputMatch) : null;
  const outputTokens = outputMatch ? Number(outputMatch) : null;
  const body = parseBody(output);
  if (!body) {
    await logTraceEvent("journal_update_error", "Journal synthesize parse failed", durationMs, {
      step: "synthesize_parse",
      message: "empty_or_invalid_json",
    });
    return null;
  }

  logLlmCall({
    kind: "journal_synthesize",
    model,
    system: JOURNAL_SYNTHESIZE_INSTRUCTION,
    prompt,
    response: output,
    durationMs,
    predictTimeMs,
    inputTokens,
    outputTokens,
    game: input.game,
    platform: input.platform,
    userId: input.userId,
    traceId: input.traceId ?? getTraceId() ?? null,
  });

  await logTraceEvent("journal_synthesize_end", "Journal body synthesized", durationMs, {
    durationMs,
    inputTokens,
    outputTokens,
    bodyCharsAfter: body.length,
  });

  return { body, durationMs, inputTokens, outputTokens };
}
