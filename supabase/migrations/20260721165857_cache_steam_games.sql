create table if not exists public.steam_games_meta (
    app_id bigint primary key,
    name text,
    platform text default 'Steam',
    release_year text,
    cover_url text,
    last_accessed_at timestamp with time zone default now()
);

-- Protect table with RLS. Since it's purely global metadata, 
-- we can just deny all direct client access and only expose via the RPC.
alter table public.steam_games_meta enable row level security;

-- RPC to bulk fetch metadata and touch last_accessed_at atomically.
-- Runs as security definer so it can bypass the RLS above.
create or replace function public.get_and_touch_steam_games(p_app_ids bigint[])
returns table (
    app_id bigint,
    name text,
    platform text,
    release_year text,
    cover_url text
)
language plpgsql
security definer
as $$
begin
    -- Update the timestamp for the requested IDs
    update public.steam_games_meta
    set last_accessed_at = now()
    where public.steam_games_meta.app_id = any(p_app_ids);

    -- Return the cached data
    return query
    select s.app_id, s.name, s.platform, s.release_year, s.cover_url
    from public.steam_games_meta s
    where s.app_id = any(p_app_ids);
end;
$$;

-- RPC to upsert missing metadata (called by the Next.js API after hitting Steam)
create or replace function public.upsert_steam_games_meta(
    p_app_ids bigint[],
    p_names text[],
    p_platforms text[],
    p_release_years text[],
    p_cover_urls text[]
)
returns void
language plpgsql
security definer
as $$
declare
    i integer;
begin
    for i in 1 .. array_length(p_app_ids, 1) loop
        insert into public.steam_games_meta (app_id, name, platform, release_year, cover_url, last_accessed_at)
        values (p_app_ids[i], p_names[i], p_platforms[i], p_release_years[i], p_cover_urls[i], now())
        on conflict (app_id) do update
        set 
            name = excluded.name,
            platform = excluded.platform,
            release_year = excluded.release_year,
            cover_url = excluded.cover_url,
            last_accessed_at = now();
    end loop;
end;
$$;

-- Setup cleanup cron job if pg_cron is supported
do $$
begin
    -- Ensure pg_cron extension exists in extensions schema
    create extension if not exists pg_cron schema extensions;
    
    -- Schedule weekly cleanup of cache untouched for 6 months
    perform cron.schedule(
        'cleanup_steam_games_meta',
        '0 0 * * 0', -- Every Sunday at midnight
        'delete from public.steam_games_meta where last_accessed_at < now() - interval ''6 months'''
    );
exception
    when others then
        raise notice 'Failed to set up pg_cron (might not be available/enabled in local db)';
end $$;
