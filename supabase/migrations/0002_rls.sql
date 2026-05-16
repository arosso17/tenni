-- Row Level Security baseline. Tighten in M1.

alter table profiles enable row level security;
alter table leagues enable row level security;
alter table league_members enable row level security;
alter table year_long_drafts enable row level security;
alter table year_long_rosters enable row level security;
alter table league_tournaments enable row level security;
alter table tournament_drafts enable row level security;
alter table tournament_picks enable row level security;
alter table week_polls enable row level security;
alter table standings_year_long enable row level security;
alter table standings_tournament_scoring enable row level security;
alter table invites enable row level security;
alter table audit_log enable row level security;

-- Public catalog (read-only to all, writes via service role)
alter table tournaments enable row level security;
alter table players enable row level security;
alter table player_tournaments enable row level security;
alter table matches enable row level security;

create policy "tournaments public read" on tournaments for select using (true);
create policy "players public read" on players for select using (true);
create policy "player_tournaments public read" on player_tournaments for select using (true);
create policy "matches public read" on matches for select using (true);

-- Profiles: users see their own + same-league members
create policy "profiles self read" on profiles
  for select using (auth.uid() = id);
create policy "profiles upsert self" on profiles
  for insert with check (auth.uid() = id);
create policy "profiles update self" on profiles
  for update using (auth.uid() = id);

-- Leagues: members see; public flag exposes
create policy "leagues member read" on leagues
  for select using (
    is_public or exists (
      select 1 from league_members m
      where m.league_id = leagues.id and m.user_id = auth.uid()
    )
  );
create policy "leagues creator insert" on leagues
  for insert with check (auth.uid() = creator_id);
create policy "leagues admin update" on leagues
  for update using (
    exists (
      select 1 from league_members m
      where m.league_id = leagues.id
        and m.user_id = auth.uid() and m.role = 'admin'
    )
  );

create policy "members self read in own leagues" on league_members
  for select using (
    user_id = auth.uid() or exists (
      select 1 from league_members m2
      where m2.league_id = league_members.league_id and m2.user_id = auth.uid()
    )
  );

-- League-scoped tables: SELECT if member of the league
create policy "year_long_drafts member read" on year_long_drafts
  for select using (exists (
    select 1 from league_members m
    where m.league_id = year_long_drafts.league_id and m.user_id = auth.uid()
  ));

create policy "year_long_rosters member read" on year_long_rosters
  for select using (exists (
    select 1 from league_members m
    where m.league_id = year_long_rosters.league_id and m.user_id = auth.uid()
  ));

create policy "league_tournaments member read" on league_tournaments
  for select using (exists (
    select 1 from league_members m
    where m.league_id = league_tournaments.league_id and m.user_id = auth.uid()
  ));

create policy "tournament_drafts member read" on tournament_drafts
  for select using (exists (
    select 1 from league_members m
    where m.league_id = tournament_drafts.league_id and m.user_id = auth.uid()
  ));

create policy "tournament_picks member read" on tournament_picks
  for select using (exists (
    select 1 from league_members m
    where m.league_id = tournament_picks.league_id and m.user_id = auth.uid()
  ));

create policy "week_polls member read" on week_polls
  for select using (exists (
    select 1 from league_members m
    where m.league_id = week_polls.league_id and m.user_id = auth.uid()
  ));

create policy "standings_yl member read" on standings_year_long
  for select using (exists (
    select 1 from league_members m
    where m.league_id = standings_year_long.league_id and m.user_id = auth.uid()
  ));

create policy "standings_ts member read" on standings_tournament_scoring
  for select using (exists (
    select 1 from league_members m
    where m.league_id = standings_tournament_scoring.league_id and m.user_id = auth.uid()
  ));

-- Mutations to picks/rosters/drafts gated through server-side RPCs (service role).
-- No public INSERT/UPDATE policies until those RPCs exist (M3/M4).
