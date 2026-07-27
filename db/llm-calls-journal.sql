-- Allow journal_synthesize rows in llm_calls.

alter table public.llm_calls drop constraint if exists llm_calls_kind_check;

alter table public.llm_calls
  add constraint llm_calls_kind_check
  check (kind in (
    'rewrite', 'summarize', 'censor', 'embed_index', 'embed_query',
    'memory_summarize', 'visual_query', 'journal_synthesize'
  ));
