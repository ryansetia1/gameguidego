-- VGMaps cache (#36): 7-day server cache of the VGMaps Atlas index (parsed entries) and
-- platform pages (raw html), read through by lib/vgmaps-cache.ts.
-- Public read only. Writes go through the service-role key (bypasses RLS), so anon
-- clients can't poison the cache. Without that key the server keeps a per-instance
-- memory copy instead. Apply in the Supabase SQL editor. Idempotent.

create table if not exists public.vgmaps_cache (
  cache_key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.vgmaps_cache enable row level security;

drop policy if exists "vgmaps_cache read" on public.vgmaps_cache;
create policy "vgmaps_cache read"
  on public.vgmaps_cache for select
  using (true);
