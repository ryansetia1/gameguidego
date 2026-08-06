-- Hybrid (vector + lexical) preferred-guide retrieval.
--
-- Apply on top of db/guide-chunks.sql. Additive: `match_guide_chunks` is
-- untouched, and lib/guide-rag.ts falls back to it when this function is absent,
-- so an install that skips this migration keeps working on vector search alone.
--
-- Why: cosine cannot separate paragraphs inside one walkthrough (they all read
-- "go north, defeat the X, open the chest"). On a real guide the 20 nearest
-- chunks spanned 0.650-0.752 and the chunk naming the boss the player asked
-- about ranked 16th, while a phrase match on that name isolated it outright.
--
-- Returns the union of the vector top-K and the lexical hits, every row carrying
-- its true cosine similarity plus `lexical_rank` (0 when the row was found by
-- vector search only) so the caller can fuse the two signals.

-- Precomputed at write time, because building it per query cost more than the
-- whole request was allowed: a 1093-chunk guide blew the statement timeout and
-- silently fell back to vector-only, which is the exact failure this function
-- exists to fix. `to_tsvector` with a literal config is immutable, so it is
-- legal in a generated column.
alter table public.guide_chunks
  add column if not exists chunk_tsv tsvector
  generated always as (to_tsvector('english', chunk_text)) stored;

create index if not exists guide_chunks_tsv_idx
  on public.guide_chunks using gin (chunk_tsv);

create or replace function public.match_guide_chunks_hybrid(
  p_guide_urls text[],
  p_guide_bundles text[],
  p_embedding vector(1024),
  p_limit int default 20,
  p_lexical_query text default ''
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
  -- not materialized: the planner then pushes each branch's own filter into the
  -- scan. Materialising instead copies every row of the guide, embeddings
  -- included, before either branch narrows it down.
  with scoped as not materialized (
    select *
    from public.guide_chunks
    where
      (cardinality(p_guide_urls) > 0 and guide_url = any(p_guide_urls))
      or (cardinality(p_guide_bundles) > 0 and guide_bundle = any(p_guide_bundles))
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
    -- Order before cutting, or a common word keeps an arbitrary 20 of its
    -- matches instead of its 20 best.
    order by rn
    limit p_limit
  )
  select
    s.guide_url,
    s.chunk_text,
    s.chunk_index,
    coalesce(s.section_path, '{}'::text[]) as section_path,
    s.section_confidence,
    1 - (s.embedding <=> p_embedding) as similarity,
    coalesce(l.rn, 0) as lexical_rank
  from scoped s
  left join vector_hits v on v.id = s.id
  left join lexical_hits l on l.id = s.id
  where v.id is not null or l.id is not null
  order by s.embedding <=> p_embedding;
$$;

grant execute on function public.match_guide_chunks_hybrid(text[], text[], vector, int, text)
  to anon, authenticated, service_role;
