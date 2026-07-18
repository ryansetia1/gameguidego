-- LLM call log for debugging and analysis (prompt, system instruction, response).
-- Run once in the Supabase SQL editor. Inserts use the anon key from the server;
-- there is intentionally no SELECT policy for client roles — inspect rows in the
-- Supabase dashboard or with the service-role key.

create table if not exists public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('rewrite', 'summarize', 'censor')),
  model text not null, -- Replicate model id, e.g. google/gemini-2.5-flash (REPLICATE_MODEL)
  system_instruction text not null,
  prompt text not null,
  response text not null default '',
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  predict_time_ms integer,
  game text,
  platform text,
  user_id uuid references auth.users (id) on delete set null
);

create index if not exists llm_calls_created_at_idx
  on public.llm_calls (created_at desc);

create index if not exists llm_calls_kind_idx
  on public.llm_calls (kind);

create index if not exists llm_calls_model_idx
  on public.llm_calls (model);

-- Patch older installs that created the table before `model` existed:
alter table public.llm_calls add column if not exists model text;
update public.llm_calls set model = 'unknown' where model is null;

alter table public.llm_calls enable row level security;

drop policy if exists "llm_calls_insert_anon" on public.llm_calls;
create policy "llm_calls_insert_anon"
  on public.llm_calls
  for insert
  to anon, authenticated
  with check (true);

-- ponytail: no SELECT/UPDATE/DELETE for anon or authenticated — logs hold full
-- prompts. Add a service-role-only read policy or dashboard access as needed.
