-- Lazy re-embed of legacy Sumopod guides to Qwen (docs/plan/embedding-fallback-replicate.md, Phase 2).
-- Additive + idempotent: no DROP/DELETE/TRUNCATE. Apply after db/embed-model-tag.sql.
-- App code fails open until this is applied (guides just stay lexical-only as before).
--
-- Design: new vectors go into STAGING columns while the live embedding/embed_model are
-- untouched, then ONE function flips every row of a guide in a single transaction. A guide
-- therefore never has mixed tags and is never half-converted, and an aborted run loses nothing.

alter table public.guide_chunks
  add column if not exists embedding_next vector(1024),
  add column if not exists embed_model_next text;

-- One row per conversion attempt: cooldown, global daily cap and concurrency cap persist here.
create table if not exists public.guide_reembed_runs (
  id bigint generated always as identity primary key,
  guide_url text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',  -- running | partial | complete | failed
  rows_staged int not null default 0
);
create index if not exists guide_reembed_runs_url_idx on public.guide_reembed_runs (guide_url, started_at desc);
create index if not exists guide_reembed_runs_started_idx on public.guide_reembed_runs (started_at desc);

-- Service-role only: RLS on with no policies denies anon/authenticated.
alter table public.guide_reembed_runs enable row level security;
revoke all on table public.guide_reembed_runs from anon, authenticated;

-- Atomically decide whether a run may start and record it. Returns {ok, reason, run_id}.
create or replace function public.claim_guide_reembed(
  p_guide_url text,
  p_cooldown_minutes int default 6,
  p_max_per_day int default 30,
  p_max_concurrent int default 2
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('guide_reembed_claim'));
  if exists (
    select 1 from guide_reembed_runs
    where guide_url = p_guide_url
      and started_at > now() - make_interval(mins => p_cooldown_minutes)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'cooldown');
  end if;
  -- Backoff: a run that failed, or was killed (still 'running' after the 6 min max lifetime),
  -- counts as a failure; 3 in 24h refuses this guide so it cannot burn the global cap.
  if (select count(*) from guide_reembed_runs
      where guide_url = p_guide_url
        and started_at > now() - interval '24 hours'
        and (status = 'failed'
             or (status = 'running' and started_at < now() - interval '6 minutes'))) >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'failing');
  end if;
  if (select count(*) from guide_reembed_runs
      where status = 'running' and started_at > now() - interval '6 minutes') >= p_max_concurrent then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if (select count(*) from guide_reembed_runs
      where started_at > now() - interval '24 hours') >= p_max_per_day then
    return jsonb_build_object('ok', false, 'reason', 'cap');
  end if;
  insert into guide_reembed_runs (guide_url) values (p_guide_url) returning id into v_id;
  return jsonb_build_object('ok', true, 'run_id', v_id);
end;
$$;

create or replace function public.finish_guide_reembed(p_run_id bigint, p_status text, p_rows int)
returns void
language sql
set search_path = public
as $$
  update guide_reembed_runs
  set finished_at = now(), status = p_status, rows_staged = p_rows
  where id = p_run_id;
$$;

-- Write staged vectors for rows [{id, v}] of ONE guide. Only touches rows still on the old
-- model with no staged vector, so replays and replaced rows are harmless. Live columns untouched.
create or replace function public.stage_guide_embeddings(
  p_guide_url text,
  p_from_model text,
  p_to_model text,
  p_rows jsonb
)
returns int
language plpgsql
set search_path = public, extensions
as $$
declare
  n int;
begin
  update guide_chunks g
  set embedding_next = x.v::vector(1024), embed_model_next = p_to_model
  from jsonb_to_recordset(p_rows) as x(id bigint, v text)
  where g.id = x.id
    and g.guide_url = p_guide_url
    and g.embed_model = p_from_model
    and g.embedding_next is null
    and x.v is not null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Runs under the caller's (PostgREST role) statement timeout; 1200 rows flip in ~40ms locally.
-- Flip a fully staged guide in one transaction. Refuses (returns 0) unless EVERY row of the guide
-- is on p_from_model and has a staged vector tagged p_to_model, so tags can never end up mixed.
create or replace function public.flip_guide_embeddings(
  p_guide_url text,
  p_from_model text,
  p_to_model text
)
returns int
language plpgsql
set search_path = public, extensions
as $$
declare
  total int;
  ready int;
  n int;
begin
  -- Briefly blocks concurrent chunk writes (insert/delete/update) so no row can appear between
  -- the readiness count and the UPDATE; the flip takes tens of ms. Readers are not blocked.
  lock table public.guide_chunks in share row exclusive mode;
  perform 1 from guide_chunks where guide_url = p_guide_url for update;
  select count(*),
         count(*) filter (
           where embed_model = p_from_model
             and embedding_next is not null
             and embed_model_next = p_to_model)
    into total, ready
    from guide_chunks where guide_url = p_guide_url;
  if total = 0 or ready <> total then
    return 0;
  end if;
  update guide_chunks
  set embedding = embedding_next,
      embed_model = embed_model_next,
      embedding_next = null,
      embed_model_next = null
  where guide_url = p_guide_url
    and embed_model = p_from_model
    and embedding_next is not null
    and embed_model_next = p_to_model;
  get diagnostics n = row_count;
  if n <> total then
    raise exception 'flip_guide_embeddings: % of % rows', n, total;
  end if;
  return n;
end;
$$;

-- These rewrite vectors: service_role only (functions default to PUBLIC execute).
revoke all on function public.claim_guide_reembed(text, int, int, int) from public, anon, authenticated;
revoke all on function public.finish_guide_reembed(bigint, text, int) from public, anon, authenticated;
revoke all on function public.stage_guide_embeddings(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.flip_guide_embeddings(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_guide_reembed(text, int, int, int) to service_role;
grant execute on function public.finish_guide_reembed(bigint, text, int) to service_role;
grant execute on function public.stage_guide_embeddings(text, text, text, jsonb) to service_role;
grant execute on function public.flip_guide_embeddings(text, text, text) to service_role;
