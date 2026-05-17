-- Per-tournament draft RPCs. Mirror year-long draft, but tier comes from seed
-- (via seed_to_tournament_tier) and quotas come from league_tournaments.pick_config.

-- Start (or restart) a tournament draft. Admin-only enforced by the calling page.
create or replace function public.start_tournament_draft(
  p_league uuid,
  p_tournament uuid,
  p_pick_order uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from league_tournaments
    where league_id = p_league and tournament_id = p_tournament
  ) then
    raise exception 'tournament not in league';
  end if;

  insert into tournament_drafts (league_id, tournament_id, status, pick_order, current_pick)
  values (p_league, p_tournament, 'active', to_jsonb(p_pick_order), 0)
  on conflict (league_id, tournament_id) do update
    set status = 'active',
        pick_order = excluded.pick_order,
        current_pick = 0
  returning id into v_id;

  -- Wipe picks for clean restart.
  delete from tournament_picks
   where league_id = p_league and tournament_id = p_tournament;

  return v_id;
end;
$$;

-- Make a tournament pick. Validates turn + seed tier + quota + lock time.
create or replace function public.pick_tournament(
  p_league uuid,
  p_tournament uuid,
  p_player uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_draft tournament_drafts%rowtype;
  v_order uuid[];
  v_n int;
  v_round int;
  v_idx int;
  v_expected uuid;
  v_pt player_tournaments%rowtype;
  v_tier text;
  v_cfg jsonb;
  v_quota int;
  v_picked int;
  v_total int;
  v_lock timestamptz;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- Lock check.
  select picks_lock_at, pick_config into v_lock, v_cfg
    from league_tournaments
   where league_id = p_league and tournament_id = p_tournament;
  if v_cfg is null then
    raise exception 'tournament not in league';
  end if;
  if v_lock is not null and now() > v_lock then
    raise exception 'picks are locked';
  end if;

  select * into v_draft
    from tournament_drafts
   where league_id = p_league and tournament_id = p_tournament
   for update;
  if v_draft.id is null then
    raise exception 'draft not started';
  end if;
  if v_draft.status <> 'active' then
    raise exception 'draft is %', v_draft.status;
  end if;

  -- Turn check (snake).
  v_order := array(select jsonb_array_elements_text(v_draft.pick_order)::uuid);
  v_n := array_length(v_order, 1);
  if v_n is null or v_n = 0 then
    raise exception 'pick_order empty';
  end if;

  v_round := v_draft.current_pick / v_n;
  v_idx := v_draft.current_pick % v_n;
  if v_round % 2 = 1 then
    v_idx := v_n - 1 - v_idx;
  end if;
  v_expected := v_order[v_idx + 1];
  if v_expected <> v_user then
    raise exception 'not your turn';
  end if;

  -- Player must be in the draw.
  select * into v_pt
    from player_tournaments
   where tournament_id = p_tournament and player_id = p_player;
  if v_pt.player_id is null then
    raise exception 'player not in this tournament draw';
  end if;

  -- Not already picked in this league/event.
  if exists (
    select 1 from tournament_picks
    where league_id = p_league and tournament_id = p_tournament and player_id = p_player
  ) then
    raise exception 'player already picked';
  end if;

  -- Tier quota.
  v_tier := public.seed_to_tournament_tier(v_pt.seed);
  v_quota := coalesce((v_cfg ->> v_tier)::int, 0);
  if v_quota = 0 then
    raise exception 'tier % is not draftable in this event', v_tier;
  end if;
  select count(*) into v_picked
    from tournament_picks tp
    join player_tournaments pt
      on pt.tournament_id = tp.tournament_id and pt.player_id = tp.player_id
   where tp.league_id = p_league
     and tp.tournament_id = p_tournament
     and tp.user_id = v_user
     and public.seed_to_tournament_tier(pt.seed) = v_tier;
  if v_picked >= v_quota then
    raise exception 'tier % full (% / %)', v_tier, v_picked, v_quota;
  end if;

  insert into tournament_picks (league_id, tournament_id, user_id, player_id, tier, pick_number)
  values (p_league, p_tournament, v_user, p_player, v_tier, v_draft.current_pick + 1);

  -- Advance turn / auto-complete.
  v_total := coalesce((v_cfg->>'top8')::int, 0)
           + coalesce((v_cfg->>'9-16')::int, 0)
           + coalesce((v_cfg->>'unseeded')::int, 0);

  update tournament_drafts
     set current_pick = current_pick + 1,
         status = case when current_pick + 1 >= v_n * v_total then 'completed' else 'active' end
   where id = v_draft.id;
end;
$$;

grant execute on function public.start_tournament_draft(uuid, uuid, uuid[])
  to authenticated;
grant execute on function public.pick_tournament(uuid, uuid, uuid)
  to authenticated;

-- Realtime.
alter publication supabase_realtime add table tournament_drafts;
alter publication supabase_realtime add table tournament_picks;

-- Convenience view: draw players with computed tier for a given tournament.
create or replace view public.draw_with_tier as
  select
    pt.tournament_id,
    pt.player_id,
    pt.seed,
    pt.status,
    pt.points_earned,
    public.seed_to_tournament_tier(pt.seed) as tier,
    p.full_name,
    p.country,
    p.current_rank,
    p.tour
  from public.player_tournaments pt
  join public.players p on p.id = pt.player_id;

grant select on public.draw_with_tier to anon, authenticated;
