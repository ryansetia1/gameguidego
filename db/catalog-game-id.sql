-- Phase 3: stable game identity via the catalog (TheGamesDB) id. Nullable and
-- additive — free-text games stay null and fall back to the normalized name key.
-- Run once in the Supabase SQL editor. Client reads tolerate the column being
-- absent (select("*")), so this can lag the deploy.

alter table public.chats
  add column if not exists catalog_game_id integer;
-- ponytail: integer matches TheGamesDB today; an IGDB swap may need text/bigint.

alter table public.player_game_memory
  add column if not exists catalog_game_id integer;

-- Memory lookup by catalog id + platform (partial: only rows that have an id).
create index if not exists player_game_memory_catalog_idx
  on public.player_game_memory (user_id, catalog_game_id, platform)
  where catalog_game_id is not null;
