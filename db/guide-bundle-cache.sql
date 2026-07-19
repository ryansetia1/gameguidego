-- GameFAQs bundle TOC discovery cache (merged page list per bundle_key).
-- 30-day TTL enforced in lib/guide-bundle-cache.js. Shared public cache
-- written by the server via the anon key (same pattern as hltb_cache).

create table if not exists public.guide_bundle_cache (
  bundle_key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.guide_bundle_cache enable row level security;

create policy "guide_bundle_cache read"
  on public.guide_bundle_cache for select
  using (true);

create policy "guide_bundle_cache insert"
  on public.guide_bundle_cache for insert
  with check (true);

create policy "guide_bundle_cache update"
  on public.guide_bundle_cache for update
  using (true);
