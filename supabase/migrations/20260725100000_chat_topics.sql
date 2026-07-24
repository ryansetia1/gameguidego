-- Multi-topic per game: each chats row is one topic thread.

alter table public.chats
  add column if not exists title text not null default '',
  add column if not exists spoiler_major boolean not null default false;

create index if not exists chats_user_game_platform_idx
  on public.chats (user_id, game, platform, updated_at desc);
