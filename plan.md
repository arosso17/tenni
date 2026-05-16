# Fantasy Tennis — Implementation Plan

## 1. Product Summary

Web + mobile-friendly site replacing the existing 2025 Google Sheet. Users join private leagues, run two parallel competitions per tour (Year-Long season draft + per-Tournament drafts), and view standings live. Real ATP/WTA ranking points drive scoring. League creators are admins; money out of scope.

---

## 2. Confirmed Game Rules (verified against `Fantasy Tennis 2025.xlsx`)

### 2.1 Two parallel competitions per tour (ATP + WTA tracked separately)

**A. Year-Long Draft** (preseason, once per tour)
Each user drafts a 15-player roster from that tour, by rank tier:
| Tier | Picks |
|---|---|
| 1–8 rank | 2 |
| 9–16 rank | 2 |
| 17–32 rank | 2 |
| 33–50 rank | 3 |
| 51–100 rank | 3 |
| 100+ rank | 3 |
| **Total** | **15** |

Score = sum of each drafted player's full-season ATP/WTA ranking points. Highest total wins the year-long title per tour.

**B. Per-Tournament Drafts** (one per event, throughout season)
Each tournament has its own draft. Picks are **NOT constrained** to the year-long roster — pulled from the actual event draw. Tier counts vary per event; commissioner configures.

Observed examples:
| Event | Picks | Tier split |
|---|---|---|
| Rolex Paris Masters (ATP 1000) | 6 | 2 top-8 / 2 (9–16) / 2 unseeded |
| Erste Bank Open Vienna (ATP 500) | 4 | 3 top-8 / 1 unseeded |
| Hong Kong Open (WTA 250) | 4 | 3 top-8 / 1 unseeded |

Score = sum of ranking points each picked player earned at that tournament. **Highest total = winner of that tournament event.**

### 2.2 Tournament Scoring (championship metric)

Counts tournament wins per user, weighted by event category. Separate ATP and WTA totals.

| Category | League points per win |
|---|---|
| Grand Slam | 10 |
| ATP/WTA Finals | 7 |
| Masters/WTA 1000 | 6 |
| ATP/WTA 500 | 3 |
| ATP/WTA 250 | 2 |

So the "season championship" per tour = whoever has the most weighted tournament wins.

### 2.3 Other rules

- **Draft format**: snake.
- **Draft order**: rotates per tournament (sheet shows different order at Paris vs Vienna).
- **Lock time**: draft completes before event start.
- **Withdrawal**: replacement player allowed, **same tier preferred**, adjacent tier with admin OK.
- **Multiple 250/500 same week**: league vote picks one. Poll closes Mon 00:00 of tournament week. Majority wins; commissioner breaks tie.
- **Season**: calendar year default, league-overridable.
- **Weeks combine ATP+WTA events** (sheet tabs are "Paris, Hong Kong" = ATP 1000 + WTA 250 same week). Each event drafted independently.

### 2.4 Two ranking-point sources to distinguish

- **Tournament-event points** = points each player earned at that specific event (e.g., reaching SF at Paris = 400). Used for per-tournament scoring.
- **Season ranking points** = player's full-year ATP/WTA tally (rolling 52-week or YTD; the sheet uses YTD). Used for year-long scoring.

Both come from the data provider (§5).

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 15 (App Router) + TypeScript** | React fluent, SSR, mobile-first via Tailwind |
| UI | **Tailwind + shadcn/ui** | Fast, accessible, mobile-ready |
| Backend | **Next.js Route Handlers** | Same repo, edge-deployable |
| DB + Auth | **Supabase** (Postgres + Auth + RLS + Realtime) | Free tier, Google OAuth, RLS for invite-only, Realtime for live scores/draft |
| Hosting | **Vercel** + **Supabase Cloud** | Both free tier |
| Cron | **Vercel Cron** (daily) + **Supabase pg_cron** (sub-daily polls) | Free |
| Tennis data | api-tennis.com primary, manual fallback | See §5 |
| Monitoring | Vercel Analytics + Sentry free | Errors + perf |

---

## 4. Data Model

```sql
profiles (
  id uuid PK references auth.users,
  display_name text,
  avatar_url text,
  created_at timestamptz default now()
);

leagues (
  id uuid PK,
  name text,
  slug text unique,
  creator_id uuid references profiles,
  season_year int,                       -- 2025, 2026
  season_start date, season_end date,
  scoring_config jsonb,                  -- tournament-scoring weights, overridable
  invite_code text unique,
  is_public bool default false,
  created_at timestamptz
);

league_members (
  league_id uuid, user_id uuid,
  role text check (role in ('admin','member')) default 'member',
  joined_at timestamptz,
  PK (league_id, user_id)
);

tournaments (
  id uuid PK,
  external_id text,
  name text,
  tour text check (tour in ('ATP','WTA')),
  category text,                         -- 250/500/1000/Slam/Finals
  draw_size int,
  surface text,
  week_start date,                       -- for grouping ATP+WTA same-week
  start_date date, end_date date,
  status text                            -- upcoming/live/completed
);

players (
  id uuid PK,
  external_id text,
  full_name text,
  tour text,
  country text,
  current_rank int,                      -- live world rank
  current_season_points int              -- live YTD ranking points
);

player_tournaments (                     -- player's draw-entry + result per event
  tournament_id uuid, player_id uuid,
  seed int,
  status text,                           -- entered/withdrew/active/eliminated
  round_reached text,                    -- R128…W
  points_earned int,                     -- points awarded at this event
  PK (tournament_id, player_id)
);

matches (
  id uuid PK,
  tournament_id uuid,
  round text,
  player1_id uuid, player2_id uuid,
  winner_id uuid,
  score text,
  status text,
  scheduled_at timestamptz,
  completed_at timestamptz
);

-- ===== Year-Long competition =====

year_long_drafts (
  id uuid PK,
  league_id uuid, tour text,             -- one per (league, tour)
  season_year int,
  format text default 'snake',
  status text,                           -- pending/active/completed
  pick_order jsonb,
  current_pick int,
  tier_quota jsonb default                -- editable per league
    '{"1-8":2,"9-16":2,"17-32":2,"33-50":3,"51-100":3,"100+":3}'
);

year_long_rosters (
  league_id uuid, user_id uuid, tour text,
  player_id uuid, tier text,
  drafted_at timestamptz,
  replaced_by uuid null references players,
  PK (league_id, user_id, tour, player_id)
);

-- ===== Per-Tournament competition =====

league_tournaments (                     -- which events this league plays
  league_id uuid, tournament_id uuid,
  picks_lock_at timestamptz,
  pick_config jsonb,                     -- {"top8":2,"9-16":2,"unseeded":2}
  draft_order jsonb,                     -- per-event order (rotates)
  status text,                           -- voted_in/locked/completed
  PK (league_id, tournament_id)
);

tournament_drafts (
  id uuid PK,
  league_id uuid, tournament_id uuid,
  status text, pick_order jsonb, current_pick int
);

tournament_picks (
  id uuid PK,
  league_id uuid, tournament_id uuid,
  user_id uuid, player_id uuid,
  tier text,                             -- top8 / 9-16 / unseeded
  pick_number int,
  replaced_by uuid null references players,
  created_at timestamptz,
  unique (league_id, tournament_id, user_id, player_id)
);

-- ===== Week voting =====

week_polls (                             -- vote when multiple 250/500 same week
  id uuid PK,
  league_id uuid,
  week_start date, tour text,
  options jsonb,                         -- [tournament_id,...]
  votes jsonb,                           -- {user_id: tournament_id}
  closes_at timestamptz,                 -- Mon 00:00 of that week
  winner_tournament_id uuid null,
  unique (league_id, week_start, tour)
);

-- ===== Standings (materialized) =====

standings_year_long (                    -- recomputed on player point change
  league_id uuid, user_id uuid, tour text,
  total_points int,
  rank int,
  updated_at timestamptz,
  PK (league_id, user_id, tour)
);

standings_tournament_scoring (           -- recomputed on event completion
  league_id uuid, user_id uuid, tour text,
  slam_wins int, finals_wins int, m1000_wins int, m500_wins int, m250_wins int,
  total_score int,
  rank int,
  updated_at timestamptz,
  PK (league_id, user_id, tour)
);

invites (
  id uuid PK,
  league_id uuid, email text, token text unique,
  invited_by uuid, accepted_at timestamptz, expires_at timestamptz
);

audit_log (
  id bigserial PK,
  actor_id uuid, league_id uuid,
  action text, payload jsonb,
  created_at timestamptz default now()
);
```

**RLS** (key):
- `leagues`, `league_members`, all picks/rosters/standings: SELECT if league member or `is_public`.
- Mutations gated by role + draft turn (server-side RPC).
- `tournaments`, `players`, `matches`, `player_tournaments`: public read.

---

## 5. Tennis Data Source

### Chosen: MatchStat Tennis API (RapidAPI)

`tennis-api-atp-wta-itf` — covers ATP/WTA/ITF. **Basic plan free, 500 req/month hard limit, 1000/hr.** 35 endpoints across Fixtures, Players, H2H, Rankings, Tournaments. Base: `https://tennis-api-atp-wta-itf.p.rapidapi.com`, `X-RapidAPI-Key` auth.

**Budget at 500 req/mo:**
| Use | Calls/mo |
|---|---|
| Rankings sync (weekly × 2 tours) | ~10 |
| Tournament calendar (weekly) | ~5 |
| Active event draws (refresh as draw evolves) | ~20 |
| Daily fixtures/results pull (event days only) | ~80 |
| On-demand reads (H2H, profiles) | ~50 |
| **Buffer** | ~335 |

**Fits if no live in-progress polling.** Results lag up to 1 hr — acceptable for fantasy. Show "match in progress" badge from `fixtures` status; refresh on user view (server-cached 15 min).

### MVP data plan

1. **MatchStatProvider** = primary auto source (rankings, calendar, draws, results).
2. **ManualProvider** = fallback + commissioner override (always available, used when API quota exhausted, draw not yet published, or correction needed).
3. **CompositeProvider** = MatchStat first, manual override wins.
4. Upgrade to Pro ($10/mo, 10k req) when group grows or live polling desired.

### Interface

```ts
interface DataProvider {
  listTournaments(year): Tournament[]
  getDraw(tournamentId): PlayerEntry[]
  getMatches(tournamentId): Match[]
  getRankings(tour): RankingRow[]    // rank + YTD points
}
```

Adapters: `MatchStatProvider`, `ManualProvider`, `CompositeProvider`.

Polling cron (Supabase pg_cron):
- Rankings: Mon 06:00 UTC.
- Calendar: Mon 06:30 UTC.
- Active draws: 06:00 UTC daily during event week.
- Results: hourly during active event days only (gated by `tournaments.status='live'`).

All writes through 15-min cache. Quota meter table tracks calls/day; alerts at 80%.

---

## 6. Scoring Engines

### 6.1 Tournament-event scoring (per pick, per event)

Sum of `player_tournaments.points_earned` for the user's picks at that event. Triggered when match completes.

Reference tables (default `scoring_config`, league-editable):

**ATP** (W / F / SF / QF / R16 / R32 / R64 / R128 / Q):
- Slam: 2000 / 1300 / 800 / 400 / 200 / 100 / 50 / 10 / 30
- Finals: +900 W bonus (1500 max), +400 F (1000 max), 200 per RR win (600 max)
- Masters 1000: 1000 / 650 / 400 / 200 / 100 / 50 / 10(30) / (10) / 30(20)
- 500: 500 / 330 / 200 / 100 / 50 / (25) / — / — / 25(16)
- 250: 250 / 165 / 100 / 50 / 25 / (13) / — / — / 13(8)

**WTA** (W / F / SF / QF / R16 / R32 / R64 / R128 / Q…):
- Slam(S): 2000 / 1300 / 780 / 430 / 240 / 130 / 70 / 10 / 40 / 30 / 20 / 2
- Finals(S): 1500\* / 1080\* / 750\* (+125 per RR match, +125 per RR win)
- 1000 (96S): 1000 / 650 / 390 / 215 / 120 / 65 / 35 / 10 / 30 / — / 20 / 2
- 500 (64S): 470 / 305 / 185 / 100 / 55 / 30 / 1 / — / 25 / — / 13 / 1
- 250 (32S): 280 / 180 / 110 / 60 / 30 / 1 / — / — / 18 / 14 / 10 / 1
- (Full table — Slams, Finals, 1000/500/250 across draw sizes — encoded in `lib/scoring/wta_table.ts`)

In practice: if `player_tournaments.points_earned` comes from the data provider, our scoring engine just sums. The encoded tables are for **manual-entry fallback** and validation.

### 6.2 Year-Long scoring

For each user roster: `sum(players.current_season_points)` for drafted (or replacement) players. Recompute when ranking-points cron updates `players.current_season_points`. Push via Realtime.

### 6.3 Tournament-Scoring (championship)

Per tour: count tournaments where this user had the highest event score, weight by `scoring_config.category_weights`, sum. Recompute on event completion. Tiebreak in event = split win (each gets a fractional? **confirm rule** — sheet doesn't show ties yet).

### 6.4 Validation

Importer (§9) replays 2025 sheet. Engine output must match every cell to ±0. Failing rows = bug.

---

## 7. Public API

REST under `/api/v1`. JWT auth via Supabase. Public reads for `is_public` leagues.

```
GET  /api/v1/leagues/:id/standings/year-long?tour=ATP|WTA
GET  /api/v1/leagues/:id/standings/tournament-scoring?tour=ATP|WTA
GET  /api/v1/leagues/:id/schedule
GET  /api/v1/leagues/:id/tournaments/:tid/picks
GET  /api/v1/leagues/:id/tournaments/:tid/standings
GET  /api/v1/tournaments/:id                 (meta + draw + matches)
GET  /api/v1/players/:id

POST /api/v1/leagues
POST /api/v1/leagues/:id/invite
POST /api/v1/leagues/:id/year-long-draft/pick
POST /api/v1/leagues/:id/tournaments/:tid/draft/pick
POST /api/v1/leagues/:id/tournaments/:tid/replacement
POST /api/v1/leagues/:id/week-polls/:pid/vote

WS   supabase realtime: league:{id}, draft:{id}
```

OpenAPI spec served at `/api/v1/openapi.json`.

---

## 8. Frontend Pages

```
/                                landing + Google sign in
/leagues                         my leagues
/leagues/new                     create league wizard
/leagues/[slug]                  dashboard: 4 standings (ATP/WTA × YL/TS), next event
/leagues/[slug]/year-long/[tour]/draft   live YL draft room
/leagues/[slug]/year-long/[tour]         roster + cumulative points
/leagues/[slug]/tournaments              calendar + week polls
/leagues/[slug]/tournaments/[tid]        event picks + live scoring
/leagues/[slug]/tournaments/[tid]/draft  live event draft room
/leagues/[slug]/admin                    settings, members, scoring config, draft orders
/join/[invite]                   accept invite
/players/[id]                    player profile + history
```

Mobile-first: bottom tab nav, sticky standings header, draft room optimized for phone (one-tap pick).

---

## 9. Milestones

**M0 — Setup (½ day)**
- Next.js + Tailwind + shadcn scaffold, Supabase project, Google OAuth, schema v1, RLS baseline, Vercel deploy preview.

**M1 — League CRUD + invites (2 days)**
- Create/join league, invites, role mgmt, profiles.

**M2 — Tennis data ingestion (3 days)**
- `DataProvider` interface + adapters: `MatchStatProvider`, `ManualProvider`, `CompositeProvider`.
- API quota meter + 15-min response cache.
- Admin manual override UI (draw edits, result corrections).
- Cron: rankings weekly, calendar weekly, draws daily-during-event, results hourly-during-event.
- **Backfill 2025 from `Fantasy Tennis 2025.xlsx`** (`scripts/import_2025.py` reads `data/sheet_dump/*.json` → seeds tournaments, players, results).

**M3 — Year-Long draft + standings (3 days)**
- Snake draft engine (server-authoritative turn).
- Tier validation (1-8/9-16/17-32/33-50/51-100/100+).
- Realtime room. Replacement flow.
- Year-long standings page + Realtime push.

**M4 — Tournament drafts + week polls (4 days)**
- Per-event draft with configurable `pick_config`.
- Week-vote poll UI (multi 250/500 conflict).
- Lock-at-event-start. Replacement on WD.
- Per-event standings + winner crowning.

**M5 — Tournament-Scoring championship + validation (2 days)**
- Recompute trigger on event complete.
- Validate engine outputs against every 2025 sheet tab. Fix discrepancies.

**M6 — Public API + docs (1 day)**
- REST endpoints + OpenAPI.

**M7 — Polish (2 days)**
- Mobile QA, empty states, error boundaries, email invites (Resend free), Sentry, analytics.

**Total ~2.5 weeks** solo. First playable end of M4.

---

## 10. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| 500 req/mo hard limit on free MatchStat tier | Cache 15 min; cron only during event days; quota meter alerts at 80%; manual fallback covers gaps; upgrade $10/mo when needed |
| Supabase free tier (500MB DB, 2GB egress) | Slim schema, paginate, vacuum logs |
| Vercel cron daily-only on free | Supabase `pg_cron` for sub-daily polls |
| Draft race conditions | Server turn check + advisory lock |
| WD/walkover scoring disputes | Admin override + audit log |
| Tournament-score ties | Confirm rule (split? tiebreak? rerun?) — defer until first tie |
| Sheet tier names differ (rank vs seed) | Year-Long uses world rank tiers; Tournament uses event seeds — already separated in schema |
| 2025 backfill discrepancies | Validation step in M5 catches before launch |

---

## 11. Repo Layout

```
tenni/
├─ app/                    Next.js routes
│  ├─ (marketing)/
│  ├─ leagues/
│  └─ api/v1/
├─ components/
├─ lib/
│  ├─ supabase/
│  ├─ scoring/
│  │  ├─ atp_table.ts
│  │  ├─ wta_table.ts
│  │  ├─ engine.ts         pure, fully unit-tested
│  │  └─ engine.test.ts
│  ├─ providers/
│  │  ├─ types.ts
│  │  ├─ matchstat.ts      (RapidAPI MatchStat ATP/WTA/ITF)
│  │  ├─ manual.ts
│  │  └─ composite.ts
│  └─ realtime/
├─ supabase/migrations/
├─ scripts/
│  ├─ dump_sheet.py        (done)
│  ├─ import_2025.py       (M2)
│  └─ poll_scores.ts       (cron entrypoint)
├─ data/
│  ├─ Fantasy Tennis 2025.xlsx
│  └─ sheet_dump/*.json    (35 tabs dumped)
├─ tests/
└─ plan.md
```

---

## 12. Open Items (small, ask as we go)

1. Tournament-event tie rule (two users same total).
2. Year-long replacement: if player retires mid-season, can user pick a new one or stuck with sunk pick?
3. Quorum for week vote (any votes at all? majority of league?).
4. Multiple leagues per user — is the year-long draft tied to a calendar year or specific league instance? (Current schema = per-league.)

---

## 13. Immediate Next Steps

1. ✅ Sheet dumped to `data/sheet_dump/`. Real rules captured.
2. Confirm §12 items (or "use defaults").
3. I scaffold M0 (Next.js + Supabase + Vercel deploy).
4. You sign up RapidAPI → MatchStat Basic plan → drop `RAPIDAPI_KEY` into Vercel env.
5. M2 importer cross-validates engine vs 2025 totals; manual override UI shipped same milestone.
6. M3 → invite your group to test league.
7. (Optional) upgrade to Pro $10/mo when quota strains.
