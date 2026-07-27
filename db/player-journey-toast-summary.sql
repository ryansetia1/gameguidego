-- Last journal toast line for poll fallback after nested after() completes.
alter table public.player_journey
  add column if not exists last_toast_summary text not null default '';
