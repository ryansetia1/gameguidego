import { DEFAULT_MODEL, isAllowedModel } from "@/lib/ai-models.js";
import { getServiceClient } from "@/lib/supabase-server.js";

export type ModelName = `${string}/${string}` | `${string}/${string}:${string}`;

export const AI_MODEL_SETTING_KEY = "ai_model";
const CACHE_MS = 30_000;
const MODEL_FORMAT = /^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/;

let cached: { model: ModelName; at: number } | null = null;

/** Admin-picked model stored in Supabase, or null when unset/unreadable. */
export async function readStoredModel(): Promise<string | null> {
  const supabase = getServiceClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", AI_MODEL_SETTING_KEY)
      .maybeSingle();
    if (error) return null;
    const value = (data as { value?: unknown } | null)?.value;
    return isAllowedModel(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The model every LLM call uses: admin choice in Supabase, else REPLICATE_MODEL,
 * else DEFAULT_MODEL. Never throws. ponytail: per-instance 30s cache, so another
 * instance can lag an admin switch by up to 30s.
 */
export async function getActiveModel(): Promise<ModelName> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.model;
  const stored = await readStoredModel();
  const env = process.env.REPLICATE_MODEL;
  const model = (stored ?? (env && MODEL_FORMAT.test(env) ? env : DEFAULT_MODEL)) as ModelName;
  cached = { model, at: Date.now() };
  return model;
}

/** Drop the cache after an admin write so this instance switches at once. */
export function clearActiveModelCache() {
  cached = null;
}
