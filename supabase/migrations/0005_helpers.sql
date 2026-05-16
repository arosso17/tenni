-- Helper functions used by draft validation and standings.

create or replace function public.rank_to_tier(p_rank int)
returns text
language sql
immutable
as $$
  select case
    when p_rank is null then '100+'
    when p_rank between 1 and 8 then '1-8'
    when p_rank between 9 and 16 then '9-16'
    when p_rank between 17 and 32 then '17-32'
    when p_rank between 33 and 50 then '33-50'
    when p_rank between 51 and 100 then '51-100'
    else '100+'
  end;
$$;

create or replace function public.seed_to_tournament_tier(p_seed int)
returns text
language sql
immutable
as $$
  select case
    when p_seed is null then 'unseeded'
    when p_seed between 1 and 8 then 'top8'
    when p_seed between 9 and 16 then '9-16'
    else 'unseeded'
  end;
$$;

-- Convenience view for year-long draft pickers: every player with computed tier.
create or replace view public.players_with_tier as
  select
    id,
    full_name,
    tour,
    country,
    current_rank,
    current_season_points,
    public.rank_to_tier(current_rank) as tier
  from public.players;

grant select on public.players_with_tier to anon, authenticated;
