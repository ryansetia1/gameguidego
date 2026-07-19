-- Bundle metadata for multi-page guides (e.g. GameFAQs FAQ). Apply after guide-chunks.sql.

alter table public.guide_chunks
  add column if not exists guide_bundle text;

create index if not exists guide_chunks_bundle_idx
  on public.guide_chunks (guide_bundle)
  where guide_bundle is not null;

drop function if exists public.match_guide_chunks(text[], vector, int);

create or replace function public.match_guide_chunks(
  p_guide_urls text[],
  p_guide_bundles text[],
  p_embedding vector(1024),
  p_limit int default 5
)
returns table (
  guide_url text,
  chunk_text text,
  similarity float
)
language sql stable
as $$
  select
    guide_url,
    chunk_text,
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
