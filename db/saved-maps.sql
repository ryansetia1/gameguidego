-- Saved maps (#36): signed-in copy of the VGMaps maps a player saved per game.
-- Metadata only (map binaries stay in the browser Cache API). The device copy
-- (localStorage `gg:saved-maps`, lib/saved-maps.js) is the offline source; this syncs it.
-- One row per user + game + image (saved_maps_user_game_image_uidx): the sync upserts
-- on that key, see mergeRemoteMaps in lib/saved-maps.js.
-- Apply in the Supabase SQL editor. Idempotent.

create table if not exists public.saved_maps (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  game text not null default '',
  platform text not null default '',
  title text not null,
  author text not null default '',
  source_url text not null,
  image_url text not null,
  dimensions text not null default '',
  file_size text not null default '',
  format text not null default '',
  width integer,
  height integer,
  last_zoom real not null default 1,
  last_offset_x real not null default 0,
  last_offset_y real not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists saved_maps_user_idx
  on public.saved_maps (user_id, game_key, created_at desc);

create unique index if not exists saved_maps_user_game_image_uidx
  on public.saved_maps (user_id, game_key, image_url);

alter table public.saved_maps enable row level security;

drop policy if exists "saved_maps select own" on public.saved_maps;
create policy "saved_maps select own"
  on public.saved_maps for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "saved_maps insert own" on public.saved_maps;
create policy "saved_maps insert own"
  on public.saved_maps for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "saved_maps update own" on public.saved_maps;
create policy "saved_maps update own"
  on public.saved_maps for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "saved_maps delete own" on public.saved_maps;
create policy "saved_maps delete own"
  on public.saved_maps for delete
  to authenticated
  using (user_id = auth.uid());
