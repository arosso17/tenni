-- Year-to-date points per (player, season_year). Sums points_earned across all
-- tournaments that started in the given calendar year. Used by year-long
-- standings instead of players.current_season_points (which is rolling 52-week).

create or replace view public.player_ytd_points as
  select
    pt.player_id,
    p.tour,
    extract(year from t.start_date)::int as season_year,
    sum(coalesce(pt.points_earned, 0))::int as ytd_points
  from public.player_tournaments pt
  join public.tournaments t on t.id = pt.tournament_id
  join public.players p on p.id = pt.player_id
  where t.start_date is not null
  group by pt.player_id, p.tour, extract(year from t.start_date);

grant select on public.player_ytd_points to anon, authenticated;
