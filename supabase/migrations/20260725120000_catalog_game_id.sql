-- Phase 3: stable game identity via the catalog (TheGamesDB) id. Nullable, additive.
-- Mirror of db/catalog-game-id.sql.

alter table public.chats
  add column if not exists catalog_game_id integer;

alter table public.player_game_memory
  add column if not exists catalog_game_id integer;

create index if not exists player_game_memory_catalog_idx
  on public.player_game_memory (user_id, catalog_game_id, platform)
  where catalog_game_id is not null;
