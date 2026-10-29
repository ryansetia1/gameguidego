import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let client = null;

/**
 * Shared server-side Supabase client (anon key, no session).
 * All server modules (caches, logs, RAG, ingest) share this single instance
 * instead of each maintaining its own singleton. Returns `null` when env vars
 * are absent, so every caller degrades gracefully.
 *
 * NOTE: This is separate from `lib/supabase.ts` (`getSupabase`) which is the
 * browser-side client used by `page.tsx` (with session/auth).
 */
export function getServerClient() {
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let serviceClient = null;

/**
 * Server-only service-role client for writes the anon RLS policies deny (e.g. deleting
 * guide_chunks). Returns `null` when the key is unset so callers fail open. NEVER
 * import this from client code and never expose the key via NEXT_PUBLIC_.
 */
export function getServiceClient() {
  if (!url || !serviceKey) return null;
  if (!serviceClient) {
    serviceClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}
