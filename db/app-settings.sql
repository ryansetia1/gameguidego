-- App-wide settings (#23): currently only the admin-picked AI model (key 'ai_model').
-- Read and written server-side with the service role only: RLS on, no policies,
-- so the anon/authenticated keys can neither read nor write it.
-- Apply in the Supabase SQL editor. Idempotent. Without it the app falls back to
-- REPLICATE_MODEL / the default model and the admin picker cannot save.

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
