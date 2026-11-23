-- Saved answers (#17): signed-in copy of replies a player bookmarked per game.
-- Snapshot of GameGuideGo's own reply (no chat FK), so deleting a chat keeps them.
-- The device copy (localStorage `gg:saved-answers`) is the offline source; this syncs it.
-- Apply in the Supabase SQL editor. Idempotent.

create table if not exists public.saved_answers (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  game text not null default '',
  platform text not null default '',
  question text not null default '',
  content text not null,
  highlights jsonb not null default '[]',
  spoilers jsonb not null default '[]',
  sources jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index if not exists saved_answers_user_idx
  on public.saved_answers (user_id, game_key, created_at desc);

alter table public.saved_answers enable row level security;

drop policy if exists "saved_answers select own" on public.saved_answers;
create policy "saved_answers select own"
  on public.saved_answers for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "saved_answers insert own" on public.saved_answers;
create policy "saved_answers insert own"
  on public.saved_answers for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "saved_answers update own" on public.saved_answers;
create policy "saved_answers update own"
  on public.saved_answers for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "saved_answers delete own" on public.saved_answers;
create policy "saved_answers delete own"
  on public.saved_answers for delete
  to authenticated
  using (user_id = auth.uid());
