-- Per-topic reference-image lookup toggle (Serper visual search).
alter table public.chats
  add column if not exists visual_search boolean not null default false;
