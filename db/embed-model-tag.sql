-- Embedding model tag per stored vector. Additive + idempotent; apply before
-- deploying the Replicate embedding fallback (docs/plan/embedding-fallback-replicate.md).
--
-- Vectors from different embedding models are NOT comparable, so every stored
-- chunk records which model produced it. Existing rows are Sumopod and backfill
-- through the default (constant default = metadata-only, no table rewrite).
-- Values name provider + version, e.g. 'sumopod' or 'replicate:qwen3-embedding-8b@42d9684'.

alter table public.guide_chunks
  add column if not exists embed_model text not null default 'sumopod';

alter table if exists public.player_journal_chunks
  add column if not exists embed_model text not null default 'sumopod';

-- New RPC instead of a new param on match_guide_chunks_hybrid: adding a param
-- creates an overload, which makes 5-arg calls from older deployed code
-- ambiguous, and replacing needs a DROP. Old RPCs stay untouched.
--
-- p_embedding null = lexical-only (guide indexed with a model that is
-- unavailable right now). p_embed_model, when set, scopes both the vector and
-- the lexical branch so cross-model vectors are never compared. No ANN index.
create or replace function public.match_guide_chunks_model(
  p_guide_urls text[],
  p_embedding vector(1024) default null,
  p_limit int default 20,
  p_lexical_query text default '',
  p_embed_model text default null
)
returns table (
  guide_url text,
  chunk_text text,
  chunk_index int,
  section_path text[],
  section_confidence real,
  similarity float,
  lexical_rank int
)
language sql stable
as $$
  with scoped as not materialized (
    select *
    from public.guide_chunks
    where cardinality(p_guide_urls) > 0
      and guide_url = any(p_guide_urls)
      and (p_embed_model is null or embed_model = p_embed_model)
  ),
  tsq as (
    select case
      when length(btrim(coalesce(p_lexical_query, ''))) > 0
        then to_tsquery('english', p_lexical_query)
    end as q
  ),
  vector_hits as (
    select s.id
    from scoped s
    where p_embedding is not null
    order by s.embedding <=> p_embedding
    limit p_limit
  ),
  lexical_hits as (
    select id, rn
    from (
      select
        s.id,
        row_number() over (
          order by ts_rank(s.chunk_tsv, t.q) desc, s.chunk_index
        )::int as rn
      from scoped s
      cross join tsq t
      where t.q is not null
        and s.chunk_tsv @@ t.q
    ) ranked
    order by rn
    limit p_limit
  )
  select
    s.guide_url,
    s.chunk_text,
    s.chunk_index,
    coalesce(s.section_path, '{}'::text[]) as section_path,
    s.section_confidence,
    coalesce(1 - (s.embedding <=> p_embedding), 0)::float as similarity,
    coalesce(l.rn, 0) as lexical_rank
  from scoped s
  left join vector_hits v on v.id = s.id
  left join lexical_hits l on l.id = s.id
  where v.id is not null or l.id is not null
  order by s.embedding <=> p_embedding nulls last, l.rn nulls last;
$$;

grant execute on function public.match_guide_chunks_model(text[], vector, int, text, text)
  to anon, authenticated, service_role;
