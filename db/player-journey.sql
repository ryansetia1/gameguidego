-- Per-game progress journal (signed-in, opt-in). Apply in Supabase SQL editor.

create table if not exists public.player_journey (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  platform text not null default '',
  catalog_game_id integer,
  body text not null default '',
  body_chars int not null default 0,
  last_updated_at timestamptz,
  last_chat_message_at timestamptz,
  last_auto_updated_at timestamptz,
  auto_update_day date,
  auto_update_count int not null default 0,
  manual_save_at timestamptz,
  updating_at timestamptz,
  last_toast_summary text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, game_key, platform)
);

create index if not exists player_journey_user_idx
  on public.player_journey (user_id);

create index if not exists player_journey_catalog_idx
  on public.player_journey (user_id, catalog_game_id, platform)
  where catalog_game_id is not null;

alter table public.player_journey enable row level security;

create policy "player_journey select own"
  on public.player_journey for select
  to authenticated
  using (user_id = auth.uid());

create policy "player_journey insert own"
  on public.player_journey for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "player_journey update own"
  on public.player_journey for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "player_journey delete own"
  on public.player_journey for delete
  to authenticated
  using (user_id = auth.uid());
