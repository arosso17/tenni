# Tenni

Fantasy tennis web app. Replaces the long-running Google Sheet with a real site:
two parallel competitions per tour (Year-Long 15-player draft, Per-Tournament event drafts),
ATP and WTA tracked separately, real ranking points drive scoring.

See [`plan.md`](./plan.md) for the full design.

## Stack

Next.js 15 + TypeScript · Tailwind + shadcn/ui · Supabase (Postgres + Auth + RLS + Realtime) · Vercel · MatchStat tennis API (RapidAPI).

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run dev
```

Env vars needed:

- `RAPIDAPI_KEY` — RapidAPI key for MatchStat tennis API
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — from Supabase project

## Migrations

SQL files in `supabase/migrations/`. Apply via Supabase dashboard SQL editor or `supabase db push` (Supabase CLI).

## Layout

```
app/                Next.js routes
lib/
  supabase/         clients (browser, server, admin)
  scoring/          pure scoring engine
  providers/        DataProvider impls (matchstat, manual)
supabase/migrations/  SQL
scripts/            data import / cron entrypoints
data/               sheet exports (gitignored)
```
