import Replicate from "replicate";

import { embedCacheKey, getCachedEmbedding, setCachedEmbedding } from "@/lib/embed-cache";
import {
  parsePositiveInt,
  sleep,
  withReplicateRetry,
} from "@/lib/replicate-retry.js";
import { logEmbedCall, type EmbedLogMeta } from "@/lib/embed-log";

const DEFAULT_EMBED_MODEL =
  "lucataco/qwen3-embedding-8b:42d968487820032a1535d81ea20df16f442ea308ec5abae6b5d6cf4675eb3e2f";
// Qwen3-Embedding is trained asymmetrically: the QUERY carries a task
// instruction, documents are embedded raw. Applied only in embedQuery.
const QUERY_INSTRUCTION =
  "Given a video game player's question, retrieve the walkthrough guide passages that answer it.";
const EMBED_DIM = 1024;
const BATCH_SIZE = 32;
// ponytail: keep low for Replicate accounts under ~$5 credit (throttles concurrency).
const CONCURRENCY = parsePositiveInt(process.env.EMBED_CONCURRENCY, 3, 8);
const BATCH_DELAY_MS = parsePositiveInt(process.env.EMBED_BATCH_DELAY_MS, 400, 5_000);

type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

function resolveEmbedModel(): ModelName | null {
  const model = process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL;
  if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) return null;
  return model as ModelName;
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

type EmbedOutput = {
  embeddings?: unknown;
};

function parseEmbeddings(output: unknown): number[][] {
  if (!output || typeof output !== "object") return [];
  const embeddings = (output as EmbedOutput).embeddings;
  if (!Array.isArray(embeddings)) return [];
  return embeddings.flatMap((row): number[][] => {
    if (!Array.isArray(row)) return [];
    const nums = row.filter((n): n is number => typeof n === "number");
    return nums.length ? [nums] : [];
  });
}

async function runEmbedBatch(
  replicate: Replicate,
  model: ModelName,
  texts: string[],
  signal?: AbortSignal,
  instruction = "",
): Promise<number[][]> {
  const raw = await withReplicateRetry(
    () =>
      replicate.run(
        model,
        {
          input: {
            text: texts.length === 1 ? texts[0] : texts,
            embedding_dim: EMBED_DIM,
            normalize: true,
            batch_size: Math.min(BATCH_SIZE, texts.length),
            ...(instruction ? { instruction } : {}),
          },
          signal: withTimeout(120_000, signal),
        },
      ),
    { signal },
  );

  const embeddings = parseEmbeddings(raw);
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embed model returned ${embeddings.length} vectors for ${texts.length} texts`,
    );
  }
  return embeddings;
}

/**
 * Embed one or more texts via Replicate. Batches automatically (up to 32).
 * Best-effort: throws when Replicate is unconfigured or the model fails.
 */
export async function embedTexts(
  texts: string[],
  signal?: AbortSignal,
  logMeta?: EmbedLogMeta,
  instruction = "",
): Promise<number[][]> {
  const token = process.env.REPLICATE_API_TOKEN;
  const model = resolveEmbedModel();
  if (!token || !model) {
    throw new Error("REPLICATE_API_TOKEN or EMBED_MODEL is not configured");
  }

  const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!cleaned.length) return [];

  const started = Date.now();
  const replicate = new Replicate({ auth: token });
  const out: number[][] = [];

  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    try {
      out.push(...(await runEmbedBatch(replicate, model, batch, signal, instruction)));
    } catch (batchError) {
      // ponytail: if batch input fails, fall back to bounded concurrency singles.
      console.error("Batch embed failed, falling back to singles:", batchError);
      const singles = await mapPool(batch, CONCURRENCY, async (text) => {
        const [vec] = await runEmbedBatch(replicate, model, [text], signal, instruction);
        return vec;
      });
      out.push(...singles);
    }
    if (i + BATCH_SIZE < cleaned.length && BATCH_DELAY_MS) {
      await sleep(BATCH_DELAY_MS, signal);
    }
  }

  logEmbedCall({
    kind: logMeta?.purpose === "rag_query" ? "embed_query" : "embed_index",
    textCount: cleaned.length,
    durationMs: Date.now() - started,
    sampleText: cleaned[0],
    meta: logMeta,
  });

  return out;
}

/** Embed a rewritten search query with a shared 7-day cache. */
export async function embedQuery(
  query: string,
  signal?: AbortSignal,
  logMeta?: EmbedLogMeta,
): Promise<number[] | null> {
  const key = embedCacheKey(query);
  if (!key) return null;

  const cached = await getCachedEmbedding(key);
  if (cached?.length) {
    logEmbedCall({
      kind: "embed_query",
      textCount: 1,
      durationMs: 0,
      sampleText: query,
      cached: true,
      meta: logMeta,
    });
    return cached;
  }

  try {
    const [embedding] = await embedTexts(
      [query],
      signal,
      logMeta ? { ...logMeta, purpose: "rag_query" } : { purpose: "rag_query" },
      QUERY_INSTRUCTION,
    );
    if (!embedding?.length) return null;
    void setCachedEmbedding(key, embedding);
    return embedding;
  } catch (error) {
    console.error("Query embed failed:", error);
    return null;
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export const EMBEDDING_DIM = EMBED_DIM;
