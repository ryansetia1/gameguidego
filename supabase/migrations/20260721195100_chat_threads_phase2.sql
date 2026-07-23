-- Phase 2: normalized chat turns + response variants.
-- thread_id = existing chats.id (chat_threads table deferred to Phase 3).
-- chats.messages remains a denormalized UI cache rebuilt from these tables.

create table if not exists public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  turn_index int not null,
  user_content text not null,
  user_images text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (chat_id, turn_index)
);

create index if not exists chat_turns_chat_id_idx on public.chat_turns (chat_id);

create table if not exists public.chat_responses (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.chat_turns (id) on delete cascade,
  variant_index int not null,
  content text not null,
  sources jsonb,
  highlights jsonb,
  spoilers jsonb,
  pipeline_type text,
  trace_id text,
  created_at timestamptz not null default now(),
  unique (turn_id, variant_index)
);

create index if not exists chat_responses_turn_id_idx on public.chat_responses (turn_id);
create index if not exists chat_responses_trace_id_idx
  on public.chat_responses (trace_id)
  where trace_id is not null;

create table if not exists public.chat_turn_state (
  turn_id uuid primary key references public.chat_turns (id) on delete cascade,
  active_variant_index int not null default 0
);

alter table public.chat_turns enable row level security;
alter table public.chat_responses enable row level security;
alter table public.chat_turn_state enable row level security;

create policy "chat_turns_select_own"
  on public.chat_turns for select
  to authenticated
  using (
    exists (
      select 1 from public.chats
      where chats.id = chat_turns.chat_id
        and chats.user_id = auth.uid()
    )
  );

create policy "chat_turns_insert_own"
  on public.chat_turns for insert
  to authenticated
  with check (
    exists (
      select 1 from public.chats
      where chats.id = chat_turns.chat_id
        and chats.user_id = auth.uid()
    )
  );

create policy "chat_turns_update_own"
  on public.chat_turns for update
  to authenticated
  using (
    exists (
      select 1 from public.chats
      where chats.id = chat_turns.chat_id
        and chats.user_id = auth.uid()
    )
  );

create policy "chat_turns_delete_own"
  on public.chat_turns for delete
  to authenticated
  using (
    exists (
      select 1 from public.chats
      where chats.id = chat_turns.chat_id
        and chats.user_id = auth.uid()
    )
  );

create policy "chat_responses_select_own"
  on public.chat_responses for select
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_responses.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_responses_insert_own"
  on public.chat_responses for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_responses.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_responses_update_own"
  on public.chat_responses for update
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_responses.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_responses_delete_own"
  on public.chat_responses for delete
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_responses.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_turn_state_select_own"
  on public.chat_turn_state for select
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_turn_state.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_turn_state_insert_own"
  on public.chat_turn_state for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_turn_state.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_turn_state_update_own"
  on public.chat_turn_state for update
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_turn_state.turn_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_turn_state_delete_own"
  on public.chat_turn_state for delete
  to authenticated
  using (
    exists (
      select 1
      from public.chat_turns t
      join public.chats c on c.id = t.chat_id
      where t.id = chat_turn_state.turn_id
        and c.user_id = auth.uid()
    )
  );
