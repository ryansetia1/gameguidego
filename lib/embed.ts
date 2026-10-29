import OpenAI from "openai";

import { embedCacheKey, getCachedEmbedding, setCachedEmbedding } from "@/lib/embed-cache";
import { getReplicate } from "@/lib/replicate";
import { logEmbedCall, type EmbedLogMeta } from "@/lib/embed-log";
import { logTraceEvent } from "@/lib/trace";

const DEFAULT_EMBED_MODEL = "text-embedding-3-large";
const EMBED_DIM = 1024;
// OpenAI embeddings.create accepts up to 2048 inputs, but we keep batches
// moderate to avoid timeouts and to allow per-batch delay for rate-limit safety.
const BATCH_SIZE = 256;
// Defaults tuned for a funded account. Lower EMBED_CONCURRENCY / raise
// EMBED_BATCH_DELAY_MS via env if throttled.
const CONCURRENCY = parsePositiveInt(process.env.EMBED_CONCURRENCY, 5, 8);
const BATCH_DELAY_MS = parsePositiveInt(process.env.EMBED_BATCH_DELAY_MS, 150, 5_000);

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

/** Tag stored on legacy rows and on anything embedded through Sumopod. */
export const SUMOPOD_MODEL_TAG = "sumopod";
// Provider + short version hash; the full hash pins the Replicate call below.
export const QWEN_MODEL_TAG = "replicate:qwen3-embedding-8b@42d9684";
const QWEN_VERSION =
  "42d968487820032a1535d81ea20df16f442ea308ec5abae6b5d6cf4675eb3e2f";
const QWEN_BATCH = 16;
const QWEN_CONCURRENCY = 4;
// Cold starts of community embedders on Replicate were seen at 96-274s, so ingest
// waits long (route maxDuration is 300s) while the per-turn query path fails fast
// to lexical-only retrieval.
const QWEN_INGEST_TIMEOUT_MS = 280_000;
const QWEN_QUERY_TIMEOUT_MS = 20_000;
const SUMOPOD_QUERY_TIMEOUT_MS = 8_000;
const QWEN_QUERY_INSTRUCTION =
  "Instruct: Given a player's question about a video game, retrieve the walkthrough passages that answer it\nQuery:";
const BREAKER_COOLDOWN_MS = 5 * 60_000;

// Circuit breaker: after a Sumopod credit/auth failure skip it for a few minutes
// instead of paying a failing round trip per embed.
// ponytail: per-instance memory, resets on cold start; move to a shared table if it matters
let sumopodSkipUntil = 0;

export type EmbedResult = { vectors: number[][]; model: string };
export type EmbedOptions = {
  /** Query-side embedding (short timeouts, Qwen instruction prefix). */
  query?: boolean;
  /** Force exactly this model tag (no fallback). Needed to search an existing guide. */
  model?: string;
};

function resolveEmbedModel(): string {
  return process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

let openaiInstance: OpenAI | null = null;

function getOpenAIEmbed(): OpenAI | null {
  const apiKey = process.env.SUMOPOD_API_KEY;
  if (!apiKey) return null;
  if (!openaiInstance) {
    openaiInstance = new OpenAI({
      apiKey,
      baseURL: process.env.SUMOPOD_BASE_URL || "https://ai.sumopod.com/v1",
      maxRetries: 3,
      timeout: 120_000,
    });
  }
  return openaiInstance;
}

/** True when at least one embedding provider is configured. */
export function isEmbedConfigured(): boolean {
  return Boolean(process.env.SUMOPOD_API_KEY || process.env.REPLICATE_API_TOKEN);
}

/** Whether `model` can be used right now (key set, breaker closed). */
export function isEmbedModelAvailable(model: string): boolean {
  if (model === QWEN_MODEL_TAG) return Boolean(process.env.REPLICATE_API_TOKEN);
  if (model === SUMOPOD_MODEL_TAG) {
    return Boolean(process.env.SUMOPOD_API_KEY) && Date.now() >= sumopodSkipUntil;
  }
  return false;
}

/** The model a fresh index would use right now (Sumopod first, else Qwen). */
export function preferredEmbedModel(): string | null {
  if (isEmbedModelAvailable(SUMOPOD_MODEL_TAG)) return SUMOPOD_MODEL_TAG;
  if (isEmbedModelAvailable(QWEN_MODEL_TAG)) return QWEN_MODEL_TAG;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCreditOrAuthError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return /quota|credit|insufficient|billing|balance|unauthorized|api key/i.test(errorMessage(error));
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error as { name?: string })?.name === "AbortError";
}

async function runEmbedBatch(
  client: OpenAI,
  model: string,
  texts: string[],
  requestOptions?: { timeout: number; maxRetries: number },
): Promise<{ embeddings: number[][]; totalTokens: number | null }> {
  const response = await client.embeddings.create(
    { model, input: texts, dimensions: EMBED_DIM },
    requestOptions,
  );

  // OpenAI returns data sorted by index, but sort explicitly to be safe.
  const sorted = [...response.data].sort((a, b) => a.index - b.index);
  const embeddings = sorted.map((item) => item.embedding);

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embed model returned ${embeddings.length} vectors for ${texts.length} texts`,
    );
  }
  return {
    embeddings,
    totalTokens: typeof response.usage?.total_tokens === "number" ? response.usage.total_tokens : null,
  };
}

/** Sumopod embed; trips the circuit breaker on credit/auth failure so every path (forced or not) skips it afterwards. */
async function embedViaSumopod(
  cleaned: string[],
  opts: EmbedOptions,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; inputTokens: number | null }> {
  if (Date.now() < sumopodSkipUntil) throw new Error("Sumopod circuit open");
  try {
    return await embedViaSumopodBatches(cleaned, opts, signal);
  } catch (error) {
    if (!isAbort(error, signal) && isCreditOrAuthError(error)) {
      sumopodSkipUntil = Date.now() + BREAKER_COOLDOWN_MS;
    }
    throw error;
  }
}

async function embedViaSumopodBatches(
  cleaned: string[],
  opts: EmbedOptions,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; inputTokens: number | null }> {
  const client = getOpenAIEmbed();
  if (!client) throw new Error("SUMOPOD_API_KEY is not configured");
  const model = resolveEmbedModel();
  const requestOptions = opts.query
    ? { timeout: SUMOPOD_QUERY_TIMEOUT_MS, maxRetries: 0 }
    : undefined;

  const out: number[][] = [];
  let inputTokens = 0;
  let hasTokenUsage = false;
  const count = (tokens: number | null) => {
    if (tokens == null) return;
    inputTokens += tokens;
    hasTokenUsage = true;
  };

  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    try {
      const result = await runEmbedBatch(client, model, batch, requestOptions);
      out.push(...result.embeddings);
      count(result.totalTokens);
    } catch (batchError) {
      // Credit/auth/abort/query failures would fail every single too: bail out now.
      if (opts.query || isAbort(batchError, signal) || isCreditOrAuthError(batchError)) {
        throw batchError;
      }
      // If batch fails, fall back to bounded concurrency singles.
      console.error("Batch embed failed, falling back to singles:", batchError);
      const singles = await mapPool(batch, CONCURRENCY, async (text) => {
        const result = await runEmbedBatch(client, model, [text]);
        count(result.totalTokens);
        return result.embeddings[0];
      });
      out.push(...singles);
    }
    if (i + BATCH_SIZE < cleaned.length && BATCH_DELAY_MS) {
      await sleep(BATCH_DELAY_MS, signal);
    }
  }
  return { vectors: out, inputTokens: hasTokenUsage ? inputTokens : null };
}

async function embedViaQwen(
  cleaned: string[],
  opts: EmbedOptions,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; inputTokens: number | null }> {
  const replicate = getReplicate();
  if (!replicate) throw new Error("REPLICATE_API_TOKEN is not configured");

  const timeoutMs = opts.query ? QWEN_QUERY_TIMEOUT_MS : QWEN_INGEST_TIMEOUT_MS;
  const callSignal = signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    : AbortSignal.timeout(timeoutMs);

  const runBatch = async (texts: string[]): Promise<number[][]> => {
    const output = (await replicate.run(`lucataco/qwen3-embedding-8b:${QWEN_VERSION}`, {
      input: {
        text: texts,
        embedding_dim: EMBED_DIM,
        normalize: true,
        batch_size: QWEN_BATCH,
        ...(opts.query ? { instruction: QWEN_QUERY_INSTRUCTION } : {}),
      },
      signal: callSignal,
    })) as { embeddings?: unknown } | null;
    const vectors = output?.embeddings;
    if (
      !Array.isArray(vectors) ||
      vectors.length !== texts.length ||
      !vectors.every((v) => Array.isArray(v) && v.length === EMBED_DIM && v.every((n) => typeof n === "number"))
    ) {
      throw new Error(`Qwen embed returned an invalid payload for ${texts.length} text(s)`);
    }
    return vectors as number[][];
  };

  const batches: string[][] = [];
  for (let i = 0; i < cleaned.length; i += QWEN_BATCH) batches.push(cleaned.slice(i, i + QWEN_BATCH));

  // First batch alone so a cold start is paid once, then the rest in parallel.
  const first = await runBatch(batches[0]);
  const rest = await mapPool(batches.slice(1), QWEN_CONCURRENCY, runBatch);
  return { vectors: [...first, ...rest.flat()], inputTokens: null };
}

async function runProvider(
  model: string,
  cleaned: string[],
  opts: EmbedOptions,
  kind: string,
  signal?: AbortSignal,
): Promise<{ vectors: number[][]; inputTokens: number | null }> {
  void logTraceEvent("embed_texts_start", `Embedding ${cleaned.length} text(s) via ${model}`, undefined, {
    kind,
    textCount: cleaned.length,
    model,
  });
  const started = Date.now();
  const result =
    model === QWEN_MODEL_TAG
      ? await embedViaQwen(cleaned, opts, signal)
      : await embedViaSumopod(cleaned, opts, signal);
  const durationMs = Date.now() - started;
  void logTraceEvent(
    "embed_texts_end",
    `Embedding complete: ${cleaned.length} text(s) in ${durationMs}ms`,
    durationMs,
    { kind, textCount: cleaned.length, model, inputTokens: result.inputTokens ?? undefined },
  );
  return result;
}

/**
 * Embed texts. Without `opts.model`, tries Sumopod first and falls back to
 * Replicate Qwen when Sumopod fails or its circuit is open; the whole input goes
 * through ONE model (never mixed) and `model` names it. With `opts.model`, uses
 * exactly that model and throws if it fails. Throws only when nothing worked.
 */
export async function embedTexts(
  texts: string[],
  signal?: AbortSignal,
  logMeta?: EmbedLogMeta,
  opts: EmbedOptions = {},
): Promise<EmbedResult> {
  const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!cleaned.length) return { vectors: [], model: opts.model ?? SUMOPOD_MODEL_TAG };

  const kind = logMeta?.purpose === "rag_query" ? "embed_query" : "embed_index";
  const totalChars = cleaned.reduce((sum, text) => sum + text.length, 0);
  const started = Date.now();

  const finish = (model: string, inputTokens: number | null, vectors: number[][]): EmbedResult => {
    logEmbedCall({
      kind,
      model,
      textCount: cleaned.length,
      durationMs: Date.now() - started,
      sampleText: cleaned[0],
      totalChars,
      inputTokens,
      meta: logMeta,
    });
    return { vectors, model };
  };

  if (opts.model) {
    const r = await runProvider(opts.model, cleaned, opts, kind, signal);
    return finish(opts.model, r.inputTokens, r.vectors);
  }

  const sumopodConfigured = Boolean(process.env.SUMOPOD_API_KEY);
  const circuitOpen = Date.now() < sumopodSkipUntil;
  let sumopodError: unknown = null;
  if (sumopodConfigured && !circuitOpen) {
    try {
      const r = await runProvider(SUMOPOD_MODEL_TAG, cleaned, opts, kind, signal);
      return finish(SUMOPOD_MODEL_TAG, r.inputTokens, r.vectors);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      sumopodError = error;
    }
  }

  const fallbackReason = sumopodError
    ? errorMessage(sumopodError).slice(0, 200)
    : sumopodConfigured
      ? "circuit_open"
      : "sumopod_unconfigured";
  void logTraceEvent("embed_fallback", `Embeddings falling back to Replicate: ${fallbackReason}`, undefined, {
    from: SUMOPOD_MODEL_TAG,
    to: QWEN_MODEL_TAG,
    reason: fallbackReason,
    circuit: Date.now() < sumopodSkipUntil ? "open" : "closed",
  });
  if (!process.env.REPLICATE_API_TOKEN) {
    throw sumopodError ?? new Error("No embedding provider is configured");
  }
  const r = await runProvider(QWEN_MODEL_TAG, cleaned, opts, kind, signal);
  return finish(QWEN_MODEL_TAG, r.inputTokens, r.vectors);
}

/**
 * Embed a rewritten search query with a shared 7-day cache. With `model`, the
 * vector comes from exactly that model (to search a guide indexed with it).
 * Returns null on any failure so callers degrade instead of erroring.
 */
export async function embedQuery(
  query: string,
  signal?: AbortSignal,
  logMeta?: EmbedLogMeta,
  model?: string,
): Promise<{ vector: number[]; model: string } | null> {
  const key = embedCacheKey(query, model);
  if (!key) return null;

  const cached = await getCachedEmbedding(key);
  if (cached?.length) {
    const cachedModel = model ?? SUMOPOD_MODEL_TAG;
    void logTraceEvent("embed_query_cache_hit", `Embed query cache hit for: ${query.slice(0, 80)}`, undefined, {
      cached: true,
      model: cachedModel,
    });
    logEmbedCall({
      kind: "embed_query",
      model: cachedModel,
      textCount: 1,
      durationMs: 0,
      sampleText: query,
      totalChars: query.length,
      inputTokens: 0,
      cached: true,
      meta: logMeta,
    });
    return { vector: cached, model: cachedModel };
  }

  void logTraceEvent("embed_query_start", `Embedding query: ${query.slice(0, 80)}`, undefined, {
    query: query.slice(0, 200),
    ...(model ? { model } : {}),
  });
  const embedStart = Date.now();
  try {
    const { vectors, model: usedModel } = await embedTexts(
      [query],
      signal,
      logMeta ? { ...logMeta, purpose: "rag_query" } : { purpose: "rag_query" },
      { query: true, ...(model ? { model } : {}) },
    );
    const embedDuration = Date.now() - embedStart;
    const vector = vectors[0];
    if (!vector?.length) {
      void logTraceEvent("embed_query_end", `Embed query returned empty`, embedDuration, { model: usedModel });
      return null;
    }
    void logTraceEvent("embed_query_end", `Embed query complete in ${embedDuration}ms`, embedDuration, { model: usedModel });
    void setCachedEmbedding(embedCacheKey(query, usedModel), vector);
    return { vector, model: usedModel };
  } catch (error) {
    const embedDuration = Date.now() - embedStart;
    void logTraceEvent("embed_query_end", `Embed query failed after ${embedDuration}ms: ${errorMessage(error)}`, embedDuration, { error: true, ...(model ? { model } : {}) });
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
