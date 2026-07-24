-- Visual reference images on assistant variants (Serper/wiki sprites).
alter table public.chat_responses
  add column if not exists illustration jsonb;
