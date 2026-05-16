-- Fix recursive RLS on league_members / leagues by routing membership checks
-- through a security-definer helper that bypasses RLS.

create or replace function public.is_league_member(p_league uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and user_id = p_user
  );
$$;

create or replace function public.is_league_admin(p_league uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and user_id = p_user and role = 'admin'
  );
$$;

grant execute on function public.is_league_member(uuid, uuid) to anon, authenticated;
grant execute on function public.is_league_admin(uuid, uuid) to anon, authenticated;

-- Rebuild policies that previously self-referenced league_members.

drop policy if exists "leagues member read" on leagues;
create policy "leagues member read" on leagues
  for select using (is_public or public.is_league_member(id, auth.uid()));

drop policy if exists "leagues admin update" on leagues;
create policy "leagues admin update" on leagues
  for update using (public.is_league_admin(id, auth.uid()));

drop policy if exists "members self read in own leagues" on league_members;
create policy "members read in own leagues" on league_members
  for select using (
    user_id = auth.uid() or public.is_league_member(league_id, auth.uid())
  );

drop policy if exists "year_long_drafts member read" on year_long_drafts;
create policy "year_long_drafts member read" on year_long_drafts
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "year_long_rosters member read" on year_long_rosters;
create policy "year_long_rosters member read" on year_long_rosters
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "league_tournaments member read" on league_tournaments;
create policy "league_tournaments member read" on league_tournaments
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "tournament_drafts member read" on tournament_drafts;
create policy "tournament_drafts member read" on tournament_drafts
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "tournament_picks member read" on tournament_picks;
create policy "tournament_picks member read" on tournament_picks
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "week_polls member read" on week_polls;
create policy "week_polls member read" on week_polls
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "standings_yl member read" on standings_year_long;
create policy "standings_yl member read" on standings_year_long
  for select using (public.is_league_member(league_id, auth.uid()));

drop policy if exists "standings_ts member read" on standings_tournament_scoring;
create policy "standings_ts member read" on standings_tournament_scoring
  for select using (public.is_league_member(league_id, auth.uid()));

-- Profiles: also allow reading other members' display names within shared leagues.
drop policy if exists "profiles co-member read" on profiles;
create policy "profiles co-member read" on profiles
  for select using (
    auth.uid() = id or exists (
      select 1
      from public.league_members me
      join public.league_members them
        on them.league_id = me.league_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );
