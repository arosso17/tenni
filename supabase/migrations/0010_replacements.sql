-- Replacement RPCs for year-long rosters and tournament picks.
-- Plan §2.3: same tier preferred; adjacent tier requires admin. For MVP we
-- only allow same-tier swaps without admin override.

-- Year-long: swap one drafted player for another. Caller must own the pick.
create or replace function public.replace_year_long(
  p_league uuid,
  p_tour text,
  p_old uuid,
  p_new uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_tier_old text;
  v_tier_new text;
  v_old players%rowtype;
  v_new players%rowtype;
  v_existing_new int;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_old = p_new then
    raise exception 'old and new player are the same';
  end if;

  -- Caller must own an active (non-replaced) pick of p_old.
  if not exists (
    select 1 from year_long_rosters
    where league_id = p_league
      and user_id = v_user
      and tour = p_tour
      and player_id = p_old
      and replaced_by is null
  ) then
    raise exception 'you do not own this pick';
  end if;

  select * into v_old from players where id = p_old;
  select * into v_new from players where id = p_new;
  if v_new.id is null then
    raise exception 'replacement player not found';
  end if;
  if v_new.tour is not null and v_new.tour <> p_tour then
    raise exception 'replacement is on % tour', v_new.tour;
  end if;

  v_tier_old := public.rank_to_tier(v_old.current_rank);
  v_tier_new := public.rank_to_tier(v_new.current_rank);
  if v_tier_old is distinct from v_tier_new then
    raise exception 'replacement must be in the same tier (% vs %)', v_tier_old, v_tier_new;
  end if;

  -- New player must not already be drafted by anyone in this league/tour (active).
  select count(*) into v_existing_new from year_long_rosters
   where league_id = p_league
     and tour = p_tour
     and player_id = p_new
     and replaced_by is null;
  if v_existing_new > 0 then
    raise exception 'replacement is already drafted in this league';
  end if;

  -- Mark old row replaced, insert new active row for same user.
  update year_long_rosters
     set replaced_by = p_new
   where league_id = p_league
     and user_id = v_user
     and tour = p_tour
     and player_id = p_old;

  insert into year_long_rosters (league_id, user_id, tour, player_id, tier)
  values (p_league, v_user, p_tour, p_new, v_tier_new);
end;
$$;

-- Tournament-pick replacement. Caller must own the pick. Same tier required
-- (top8 / 9-16 / unseeded — based on seed in player_tournaments).
create or replace function public.replace_tournament_pick(
  p_league uuid,
  p_tournament uuid,
  p_old uuid,
  p_new uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_old_seed int;
  v_new_seed int;
  v_old_tier text;
  v_new_tier text;
  v_pick_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_old = p_new then
    raise exception 'old and new player are the same';
  end if;

  -- Caller must own a non-replaced pick of p_old.
  select id into v_pick_id from tournament_picks
   where league_id = p_league
     and tournament_id = p_tournament
     and user_id = v_user
     and player_id = p_old
     and replaced_by is null;
  if v_pick_id is null then
    raise exception 'you do not own this pick';
  end if;

  -- New player must be in the draw.
  select seed into v_new_seed from player_tournaments
   where tournament_id = p_tournament and player_id = p_new;
  if not found then
    raise exception 'replacement is not in this tournament draw';
  end if;
  select seed into v_old_seed from player_tournaments
   where tournament_id = p_tournament and player_id = p_old;

  v_old_tier := public.seed_to_tournament_tier(v_old_seed);
  v_new_tier := public.seed_to_tournament_tier(v_new_seed);
  if v_old_tier is distinct from v_new_tier then
    raise exception 'replacement must be in the same tier (% vs %)', v_old_tier, v_new_tier;
  end if;

  -- New player must not already be picked in this event/league (active).
  if exists (
    select 1 from tournament_picks
    where league_id = p_league
      and tournament_id = p_tournament
      and player_id = p_new
      and replaced_by is null
  ) then
    raise exception 'replacement is already picked in this event';
  end if;

  update tournament_picks
     set replaced_by = p_new
   where id = v_pick_id;

  insert into tournament_picks (league_id, tournament_id, user_id, player_id, tier)
  values (p_league, p_tournament, v_user, p_new, v_new_tier);
end;
$$;

grant execute on function public.replace_year_long(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.replace_tournament_pick(uuid, uuid, uuid, uuid) to authenticated;
