-- Journal RAG chunks (user-scoped). Apply after player-journey.sql and vector extension.

create table if not exists public.player_journal_chunks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_key text not null,
  platform text not null default '',
  chunk_index int not null,
  chunk_text text not null,
  embedding vector(1024) not null,
  created_at timestamptz not null default now()
);

create index if not exists player_journal_chunks_lookup_idx
  on public.player_journal_chunks (user_id, game_key, platform);

create unique index if not exists player_journal_chunks_unique_idx
  on public.player_journal_chunks (user_id, game_key, platform, chunk_index);

-- No ANN index on embedding — filter btree first, exact cosine on small set.

alter table public.player_journal_chunks enable row level security;

create policy "player_journal_chunks select own"
  on public.player_journal_chunks for select
  to authenticated
  using (user_id = auth.uid());

create policy "player_journal_chunks insert own"
  on public.player_journal_chunks for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "player_journal_chunks delete own"
  on public.player_journal_chunks for delete
  to authenticated
  using (user_id = auth.uid());

create or replace function public.match_player_journal_chunks(
  p_user_id uuid,
  p_game_key text,
  p_platform text,
  p_embedding vector(1024),
  p_limit int default 5
)
returns table (
  chunk_text text,
  chunk_index int,
  similarity float
)
language sql stable
as $$
  select
    chunk_text,
    chunk_index,
    1 - (embedding <=> p_embedding) as similarity
  from public.player_journal_chunks
  where
    user_id = p_user_id
    and p_user_id = auth.uid()
    and game_key = p_game_key
    and platform = coalesce(p_platform, '')
  order by embedding <=> p_embedding
  limit p_limit;
$$;

grant execute on function public.match_player_journal_chunks(uuid, text, text, vector, int)
  to authenticated, service_role;
