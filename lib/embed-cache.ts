import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Namespace the cache by embedding model, so swapping EMBED_MODEL (different
// vector dimension) can't serve a stale wrong-dim vector into match_guide_chunks.
const MODEL_TAG = (process.env.EMBED_MODEL || "default").split(":")[0];

export function embedCacheKey(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized ? `${MODEL_TAG}|${normalized}` : "";
}

function toVectorString(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === "number") ? value : null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((n) => typeof n === "number")
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Read a cached query embedding. Best-effort; null on miss or expiry. */
export async function getCachedEmbedding(key: string): Promise<number[] | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("embed_cache")
      .select("embedding, created_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (error || !data) return null;

    const createdAt = new Date((data as { created_at: string }).created_at).getTime();
    if (Number.isNaN(createdAt) || Date.now() - createdAt > TTL_MS) return null;

    return parseVector((data as { embedding: unknown }).embedding);
  } catch {
    return null;
  }
}

/** Write a query embedding to the cache. Best-effort; failures never block. */
export async function setCachedEmbedding(key: string, embedding: number[]): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  try {
    await supabase.from("embed_cache").upsert({
      cache_key: key,
      embedding: toVectorString(embedding),
      created_at: new Date().toISOString(),
    });
  } catch {
    // Swallowed on purpose: answers must not depend on the cache.
  }
}

export { toVectorString };
