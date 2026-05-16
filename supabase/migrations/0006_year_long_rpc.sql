-- Year-long draft RPCs.
-- All run as security definer so callers don't need INSERT/UPDATE policies on
-- year_long_drafts / year_long_rosters / standings_year_long.

-- Helper: count user's roster picks per tier for a tour.
create or replace function public.year_long_tier_counts(
  p_league uuid, p_tour text, p_user uuid
)
returns table (tier text, picked int)
language sql
stable
security definer
set search_path = public
as $$
  select public.rank_to_tier(p.current_rank) as tier,
         count(*)::int as picked
  from year_long_rosters r
  join players p on p.id = r.player_id
  where r.league_id = p_league
    and r.tour = p_tour
    and r.user_id = p_user
  group by 1;
$$;

-- Start (or restart) a year-long draft. Admin-only enforced by the calling page.
create or replace function public.start_year_long_draft(
  p_league uuid,
  p_tour text,
  p_pick_order uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int;
  v_id uuid;
begin
  select season_year into v_year from leagues where id = p_league;
  if v_year is null then
    raise exception 'league not found';
  end if;

  insert into year_long_drafts (league_id, tour, season_year, status, pick_order, current_pick)
  values (p_league, p_tour, v_year, 'active', to_jsonb(p_pick_order), 0)
  on conflict (league_id, tour, season_year) do update
    set status = 'active',
        pick_order = excluded.pick_order,
        current_pick = 0
  returning id into v_id;

  -- Wipe rosters for this tour so a restart is clean.
  delete from year_long_rosters
   where league_id = p_league and tour = p_tour;

  return v_id;
end;
$$;

-- Make a year-long pick. Validates turn + tier quota; advances current_pick.
create or replace function public.pick_year_long(
  p_league uuid,
  p_tour text,
  p_player uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_draft year_long_drafts%rowtype;
  v_order uuid[];
  v_n int;
  v_round int;
  v_idx int;
  v_expected uuid;
  v_player players%rowtype;
  v_tier text;
  v_quota int;
  v_picked int;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into v_draft
    from year_long_drafts
   where league_id = p_league and tour = p_tour
   for update;
  if v_draft.id is null then
    raise exception 'draft not started';
  end if;
  if v_draft.status <> 'active' then
    raise exception 'draft is %', v_draft.status;
  end if;

  -- Compute whose turn it is from pick_order using snake walk.
  v_order := array(select jsonb_array_elements_text(v_draft.pick_order)::uuid);
  v_n := array_length(v_order, 1);
  if v_n is null or v_n = 0 then
    raise exception 'pick_order empty';
  end if;

  v_round := v_draft.current_pick / v_n;
  v_idx := v_draft.current_pick % v_n;
  if v_round % 2 = 1 then
    v_idx := v_n - 1 - v_idx;  -- snake reverses on odd rounds
  end if;
  v_expected := v_order[v_idx + 1];

  if v_expected <> v_user then
    raise exception 'not your turn';
  end if;

  -- Player exists, on the right tour, and not already drafted in this league/tour.
  select * into v_player from players where id = p_player;
  if v_player.id is null then
    raise exception 'player not found';
  end if;
  if v_player.tour is not null and v_player.tour <> p_tour then
    raise exception 'player is on the % tour', v_player.tour;
  end if;
  if exists (
    select 1 from year_long_rosters
    where league_id = p_league and tour = p_tour and player_id = p_player
  ) then
    raise exception 'player already drafted in this league';
  end if;

  -- Tier quota check.
  v_tier := public.rank_to_tier(v_player.current_rank);
  v_quota := coalesce((v_draft.tier_quota ->> v_tier)::int, 0);
  if v_quota = 0 then
    raise exception 'tier % is not draftable in this league', v_tier;
  end if;
  select count(*) into v_picked
    from year_long_rosters r
    join players p on p.id = r.player_id
   where r.league_id = p_league and r.tour = p_tour and r.user_id = v_user
     and public.rank_to_tier(p.current_rank) = v_tier;
  if v_picked >= v_quota then
    raise exception 'tier % full (% / %)', v_tier, v_picked, v_quota;
  end if;

  insert into year_long_rosters (league_id, user_id, tour, player_id, tier)
  values (p_league, v_user, p_tour, p_player, v_tier);

  -- Advance turn.
  update year_long_drafts
     set current_pick = current_pick + 1,
         status = case
           when current_pick + 1 >= v_n * (
             (tier_quota->>'1-8')::int + (tier_quota->>'9-16')::int +
             (tier_quota->>'17-32')::int + (tier_quota->>'33-50')::int +
             (tier_quota->>'51-100')::int + (tier_quota->>'100+')::int
           ) then 'completed'
           else 'active'
         end
   where id = v_draft.id;
end;
$$;

grant execute on function public.start_year_long_draft(uuid, text, uuid[])
  to authenticated;
grant execute on function public.pick_year_long(uuid, text, uuid)
  to authenticated;
grant execute on function public.year_long_tier_counts(uuid, text, uuid)
  to authenticated;

-- Realtime: enable for the tables clients subscribe to.
alter publication supabase_realtime add table year_long_drafts;
alter publication supabase_realtime add table year_long_rosters;
