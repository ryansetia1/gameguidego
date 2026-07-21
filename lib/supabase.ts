import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

/**
 * Shared browser Supabase client, or `null` when the env vars are absent so the
 * app degrades to anonymous-only use (accounts and saving simply stay off).
 * A singleton avoids the "multiple GoTrueClient instances" warning.
 */
export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null;
  if (!client) client = createClient(url, anonKey);
  return client;
}

export type Chat = {
  id: string;
  game: string;
  platform: string;
  preferred_guide_url: string;
  /** Optional: absent until preferred-guide-urls migration (db/preferred-guide-urls.sql). */
  preferred_guide_urls?: string[];
  // Optional: absent until the cover-metadata migration is applied (see
  // db/cover-metadata.sql). `cover_url` may be a TheGamesDB CDN URL or a
  // Supabase Storage public URL from a device upload.
  cover_url?: string;
  release_year?: string;
  /** Signed-in: read from normalized tables. Anon/local: stored inline. */
  messages?: unknown;
  updated_at: string;
};
