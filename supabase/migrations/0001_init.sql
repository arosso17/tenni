-- Initial schema. See plan.md §4. Migration applied via supabase CLI in M0.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  creator_id uuid not null references profiles(id),
  season_year int not null,
  season_start date,
  season_end date,
  scoring_config jsonb not null default '{}'::jsonb,
  invite_code text unique not null default encode(gen_random_bytes(8), 'hex'),
  is_public bool not null default false,
  created_at timestamptz not null default now()
);

create table if not exists league_members (
  league_id uuid references leagues(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  role text not null check (role in ('admin','member')) default 'member',
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- Tennis catalog (public read)
create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  name text not null,
  tour text not null check (tour in ('ATP','WTA')),
  category text not null,
  draw_size int,
  surface text,
  week_start date,
  start_date date not null,
  end_date date,
  status text not null default 'upcoming'
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  full_name text not null,
  tour text check (tour in ('ATP','WTA')),
  country text,
  current_rank int,
  current_season_points int
);

create table if not exists player_tournaments (
  tournament_id uuid references tournaments(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  seed int,
  status text,
  round_reached text,
  points_earned int default 0,
  primary key (tournament_id, player_id)
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete cascade,
  round text not null,
  player1_id uuid references players(id),
  player2_id uuid references players(id),
  winner_id uuid references players(id),
  score text,
  status text not null default 'scheduled',
  scheduled_at timestamptz,
  completed_at timestamptz
);

-- Year-Long competition
create table if not exists year_long_drafts (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  tour text not null check (tour in ('ATP','WTA')),
  season_year int not null,
  format text not null default 'snake',
  status text not null default 'pending',
  pick_order jsonb,
  current_pick int default 0,
  tier_quota jsonb not null default
    '{"1-8":2,"9-16":2,"17-32":2,"33-50":3,"51-100":3,"100+":3}'::jsonb,
  unique (league_id, tour, season_year)
);

create table if not exists year_long_rosters (
  league_id uuid references leagues(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  tour text not null check (tour in ('ATP','WTA')),
  player_id uuid references players(id),
  tier text not null,
  drafted_at timestamptz not null default now(),
  replaced_by uuid references players(id),
  primary key (league_id, user_id, tour, player_id)
);

-- Per-Tournament competition
create table if not exists league_tournaments (
  league_id uuid references leagues(id) on delete cascade,
  tournament_id uuid references tournaments(id) on delete cascade,
  picks_lock_at timestamptz,
  pick_config jsonb not null default '{"top8":2,"9-16":2,"unseeded":2}'::jsonb,
  draft_order jsonb,
  status text not null default 'voted_in',
  primary key (league_id, tournament_id)
);

create table if not exists tournament_drafts (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  status text not null default 'pending',
  pick_order jsonb,
  current_pick int default 0,
  unique (league_id, tournament_id)
);

create table if not exists tournament_picks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  user_id uuid not null references profiles(id),
  player_id uuid not null references players(id),
  tier text not null,
  pick_number int,
  replaced_by uuid references players(id),
  created_at timestamptz not null default now(),
  unique (league_id, tournament_id, user_id, player_id)
);

-- Week voting
create table if not exists week_polls (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  week_start date not null,
  tour text not null check (tour in ('ATP','WTA')),
  options jsonb not null,
  votes jsonb not null default '{}'::jsonb,
  closes_at timestamptz not null,
  winner_tournament_id uuid references tournaments(id),
  unique (league_id, week_start, tour)
);

-- Standings (materialized)
create table if not exists standings_year_long (
  league_id uuid references leagues(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  tour text not null check (tour in ('ATP','WTA')),
  total_points int not null default 0,
  rank int,
  updated_at timestamptz not null default now(),
  primary key (league_id, user_id, tour)
);

create table if not exists standings_tournament_scoring (
  league_id uuid references leagues(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  tour text not null check (tour in ('ATP','WTA')),
  slam_wins int not null default 0,
  finals_wins int not null default 0,
  m1000_wins int not null default 0,
  m500_wins int not null default 0,
  m250_wins int not null default 0,
  total_score int not null default 0,
  rank int,
  updated_at timestamptz not null default now(),
  primary key (league_id, user_id, tour)
);

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  email text,
  token text unique not null default encode(gen_random_bytes(16), 'hex'),
  invited_by uuid references profiles(id),
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days')
);

create table if not exists audit_log (
  id bigserial primary key,
  actor_id uuid references profiles(id),
  league_id uuid references leagues(id) on delete cascade,
  action text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_player_tournaments_player on player_tournaments(player_id);
create index if not exists idx_matches_tournament on matches(tournament_id);
create index if not exists idx_tournament_picks_user on tournament_picks(league_id, user_id);
create index if not exists idx_year_long_rosters_user on year_long_rosters(league_id, user_id, tour);
