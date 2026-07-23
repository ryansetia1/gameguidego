-- Player style memory (opt-in signed-in feature). Run once in Supabase SQL editor.

create table if not exists public.player_memory_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  message_count integer not null default 0 check (message_count >= 0),
  tier text not null default 'collecting'
    check (tier in ('collecting', 'draft', 'full')),
  style jsonb not null default '{}'::jsonb,
  enabled_at timestamptz not null default now(),
  last_summarized_at timestamptz,
  last_manual_refresh_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.player_game_memory (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  platform text not null default '',
  progress text,
  notes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, game_key, platform)
);

create index if not exists player_game_memory_user_idx
  on public.player_game_memory (user_id);

alter table public.player_memory_state enable row level security;
alter table public.player_game_memory enable row level security;

create policy "player_memory_state select own"
  on public.player_memory_state for select
  to authenticated
  using (user_id = auth.uid());

create policy "player_memory_state insert own"
  on public.player_memory_state for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "player_memory_state update own"
  on public.player_memory_state for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "player_memory_state delete own"
  on public.player_memory_state for delete
  to authenticated
  using (user_id = auth.uid());

create policy "player_game_memory select own"
  on public.player_game_memory for select
  to authenticated
  using (user_id = auth.uid());

create policy "player_game_memory insert own"
  on public.player_game_memory for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "player_game_memory update own"
  on public.player_game_memory for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "player_game_memory delete own"
  on public.player_game_memory for delete
  to authenticated
  using (user_id = auth.uid());
