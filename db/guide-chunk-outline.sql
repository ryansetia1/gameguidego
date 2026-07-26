-- Guide chunk outline metadata for rules-based rescoring.
-- Run once in the Supabase SQL editor after guide-chunks.sql.

alter table public.guide_chunks
  add column if not exists section_path text[] not null default '{}',
  add column if not exists section_confidence real;

create or replace function public.match_guide_chunks(
  p_guide_urls text[],
  p_guide_bundles text[],
  p_embedding vector(1024),
  p_limit int default 5
)
returns table (
  guide_url text,
  chunk_text text,
  chunk_index int,
  section_path text[],
  section_confidence real,
  similarity float
)
language sql stable
as $$
  select
    guide_url,
    chunk_text,
    chunk_index,
    coalesce(section_path, '{}'::text[]) as section_path,
    section_confidence,
    1 - (embedding <=> p_embedding) as similarity
  from public.guide_chunks
  where
    (cardinality(p_guide_urls) > 0 and guide_url = any(p_guide_urls))
    or (cardinality(p_guide_bundles) > 0 and guide_bundle = any(p_guide_bundles))
  order by embedding <=> p_embedding
  limit p_limit;
$$;

grant execute on function public.match_guide_chunks(text[], text[], vector, int)
  to anon, authenticated, service_role;
