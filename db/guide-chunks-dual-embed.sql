-- Dual-vector backup embeddings on public.guide_chunks (Phase 2 lazy failover).
-- Safe + idempotent. Preserves the primary `embedding` / `embed_model` untouched
-- while storing backup vectors (e.g. Replicate Qwen) in `embedding_next` /
-- `embed_model_next` so primary vectors resume working immediately when recovered.

alter table public.guide_chunks
  add column if not exists embedding_next vector(1024);

alter table public.guide_chunks
  add column if not exists embed_model_next text;

-- Dual-column vector + lexical hybrid search.
-- p_embedding null = lexical-only (all stored models for this guide are down).
-- p_embed_model selects whichever column (primary or next) matches p_embed_model.
create or replace function public.match_guide_chunks_dual(
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
    select
      id,
      guide_url,
      chunk_text,
      chunk_index,
      section_path,
      section_confidence,
      chunk_tsv,
      case
        when p_embed_model is null or embed_model = p_embed_model then embedding
        when embed_model_next = p_embed_model then embedding_next
        else null
      end as active_embedding
    from public.guide_chunks
    where cardinality(p_guide_urls) > 0
      and guide_url = any(p_guide_urls)
      and (
        p_embed_model is null
        or embed_model = p_embed_model
        or embed_model_next = p_embed_model
      )
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
      and s.active_embedding is not null
    order by s.active_embedding <=> p_embedding
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
    coalesce(1 - (s.active_embedding <=> p_embedding), 0)::float as similarity,
    coalesce(l.rn, 0) as lexical_rank
  from scoped s
  left join vector_hits v on v.id = s.id
  left join lexical_hits l on l.id = s.id
  where v.id is not null or l.id is not null
  order by s.active_embedding <=> p_embedding nulls last, l.rn nulls last;
$$;

grant execute on function public.match_guide_chunks_dual(text[], vector, int, text, text)
  to anon, authenticated, service_role;
