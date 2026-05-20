import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueAdmin, requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { countryFlag } from '@/lib/flag'
import { scrapeSackmannYear } from '@/lib/sackmannDraws'
import { scrapeWikiResults } from '@/lib/wikiDraws'

const ROUND_RANK: Record<string, number> = {
  R128: 1, R64: 2, R32: 3, R16: 4, QF: 5, SF: 6, F: 7, W: 8, RR: 3,
}

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function syncSackmannYear(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tour = String(formData.get('tour')) as 'ATP' | 'WTA'
  const year = parseInt(String(formData.get('year')), 10)
  await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const { data: tournaments } = await admin
    .from('tournaments')
    .select('id, name, category, tour, start_date, draw_size')
    .eq('tour', tour)
    .gte('start_date', `${year}-01-01`)
    .lte('start_date', `${year}-12-31`)
  const dbTournaments = (tournaments ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    draw_size: t.draw_size as number | null,
    start_date: t.start_date as string,
  }))

  const matches = await scrapeSackmannYear(year, tour, dbTournaments)
  let upserts = 0
  let createdPlayers = 0

  // Collect all unique names → batch fetch/insert players first.
  const allNames = new Set<string>()
  for (const m of matches) for (const e of m.entries) allNames.add(e.name)

  const nameToId = new Map<string, string>()
  const namesArr = [...allNames]
  // Batch fetch existing players in chunks (in() limit ~1000).
  for (let i = 0; i < namesArr.length; i += 500) {
    const chunk = namesArr.slice(i, i + 500)
    const { data } = await admin
      .from('players')
      .select('id, full_name')
      .eq('tour', tour)
      .in('full_name', chunk)
    for (const p of data ?? []) nameToId.set(p.full_name, p.id)
  }

  // Insert missing players in batches.
  const missing = namesArr.filter((n) => !nameToId.has(n))
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200)
    const countries = new Map<string, string | null>()
    for (const m of matches) for (const e of m.entries) if (chunk.includes(e.name)) countries.set(e.name, e.country)
    const rows = chunk.map((n) => ({ full_name: n, tour, country: countries.get(n) ?? null }))
    const { data } = await admin.from('players').insert(rows).select('id, full_name')
    for (const p of data ?? []) {
      nameToId.set(p.full_name, p.id)
      createdPlayers++
    }
  }

  // Bulk upsert player_tournaments per tournament.
  for (const m of matches) {
    const rows = m.entries
      .map((e) => {
        const pid = nameToId.get(e.name)
        if (!pid) return null
        return {
          tournament_id: m.tournamentId,
          player_id: pid,
          seed: e.seed,
          status: e.round_reached === 'W' ? 'completed' : 'entered',
          round_reached: e.round_reached || null,
          points_earned: e.points_earned,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (rows.length === 0) continue
    await admin.from('player_tournaments').upsert(rows, {
      onConflict: 'tournament_id,player_id',
    })
    upserts += rows.length
  }

  // --- Wiki fallback for events Sackmann didn't fully score yet. ---
  // Treat "needs Wiki" as: tournament with start_date in past, draw_size known,
  // and no player currently has round_reached='W' in player_tournaments.
  const todayIso = new Date().toISOString().slice(0, 10)
  let wikiTournaments = 0
  let wikiRows = 0

  for (const t of dbTournaments) {
    if (t.start_date > todayIso) continue // event hasn't started

    const { data: existing } = await admin
      .from('player_tournaments')
      .select('player_id, round_reached, points_earned, seed')
      .eq('tournament_id', t.id)
    const hasWinner = (existing ?? []).some((r) => r.round_reached === 'W')
    if (hasWinner) continue

    const { entries } = await scrapeWikiResults(
      year,
      t.name,
      tour,
      t.category,
      t.draw_size ?? 0,
    )
    if (entries.length === 0) continue

    // Resolve player IDs (batched).
    const wikiNames = entries.map((e) => e.name)
    const nameMap = new Map<string, string>()
    for (let i = 0; i < wikiNames.length; i += 500) {
      const chunk = wikiNames.slice(i, i + 500)
      const { data } = await admin
        .from('players')
        .select('id, full_name')
        .eq('tour', tour)
        .in('full_name', chunk)
      for (const p of data ?? []) nameMap.set(p.full_name, p.id)
    }
    const missing = wikiNames.filter((n) => !nameMap.has(n))
    if (missing.length > 0) {
      const rows = missing.map((n) => {
        const e = entries.find((x) => x.name === n)
        return { full_name: n, tour, country: e?.country ?? null }
      })
      const { data: inserted } = await admin.from('players').insert(rows).select('id, full_name')
      for (const p of inserted ?? []) nameMap.set(p.full_name, p.id)
    }

    const existingByPid = new Map<string, { round_reached: string | null; points_earned: number | null; seed: number | null }>()
    for (const r of existing ?? []) existingByPid.set(r.player_id, r)

    const toUpsert: Array<{
      tournament_id: string
      player_id: string
      seed: number | null
      status: string
      round_reached: string | null
      points_earned: number
    }> = []
    for (const e of entries) {
      const pid = nameMap.get(e.name)
      if (!pid) continue
      const ex = existingByPid.get(pid)
      const wikiRank = ROUND_RANK[e.round_reached] ?? 0
      const exRank = ex?.round_reached ? ROUND_RANK[ex.round_reached] ?? 0 : 0
      // Only upsert if Wiki has same-or-further round than DB (avoids regressing
      // Sackmann data with stale Wiki). Also seed-only update if not yet set.
      if (wikiRank > exRank) {
        toUpsert.push({
          tournament_id: t.id,
          player_id: pid,
          seed: e.seed ?? ex?.seed ?? null,
          status: e.round_reached === 'W' ? 'completed' : 'entered',
          round_reached: e.round_reached || null,
          points_earned: e.points_earned,
        })
      }
    }
    if (toUpsert.length > 0) {
      await admin.from('player_tournaments').upsert(toUpsert, {
        onConflict: 'tournament_id,player_id',
      })
      wikiTournaments++
      wikiRows += toUpsert.length
    }
  }

  revalidatePath(`/leagues/${slug}/year-long/${tour.toLowerCase()}`)
  revalidatePath(`/leagues/${slug}/championship/${tour.toLowerCase()}`)
  redirect(
    `/leagues/${slug}/year-long/${tour.toLowerCase()}?sync=${matches.length}&rows=${upserts}&new=${createdPlayers}&wiki=${wikiTournaments}&wikirows=${wikiRows}`,
  )
}

const TIERS = ['1-8', '9-16', '17-32', '33-50', '51-100', '100+'] as const

export default async function YearLongPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; tour: string }>
  searchParams: Promise<{ sync?: string; rows?: string; new?: string; wiki?: string; wikirows?: string }>
}) {
  const { slug, tour: tourParam } = await params
  const { sync, rows: syncRows, new: syncNew, wiki: syncWiki, wikirows: syncWikiRows } = await searchParams
  const tour = tourParam.toUpperCase()
  if (tour !== 'ATP' && tour !== 'WTA') notFound()

  const { league, role, user } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const [{ data: draft }, { data: members }, { data: rosters }] = await Promise.all([
    admin
      .from('year_long_drafts')
      .select('id, status, pick_order, current_pick, tier_quota')
      .eq('league_id', league.id)
      .eq('tour', tour)
      .maybeSingle(),
    admin
      .from('league_members')
      .select('user_id, profiles(display_name)')
      .eq('league_id', league.id),
    admin
      .from('year_long_rosters')
      .select('user_id, tier, players:players!year_long_rosters_player_id_fkey(id, full_name, country, current_rank)')
      .eq('league_id', league.id)
      .eq('tour', tour)
      .is('replaced_by', null),
  ])

  // YTD points per player for this season (replaces rolling 52-week points).
  const rosterPlayerIds = Array.from(
    new Set(
      (rosters ?? [])
        .map((r) => {
          const p = Array.isArray(r.players) ? r.players[0] : r.players
          return (p as { id?: string } | null)?.id
        })
        .filter((x): x is string => !!x)
    )
  )
  let ytdByPlayer = new Map<string, number>()
  if (rosterPlayerIds.length) {
    const { data: ytdRows } = await admin
      .from('player_ytd_points')
      .select('player_id, ytd_points')
      .eq('season_year', league.season_year)
      .eq('tour', tour)
      .in('player_id', rosterPlayerIds)
    ytdByPlayer = new Map((ytdRows ?? []).map((r) => [r.player_id, r.ytd_points ?? 0]))
  }

  const memberByUser = new Map(
    (members ?? []).map((m) => [
      m.user_id,
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ?? m.user_id.slice(0, 6),
    ])
  )

  type PlayerLite = { id: string; full_name: string; country: string | null; current_rank: number | null; ytd_points: number }
  type Pick = { player: PlayerLite; tier: string }
  const byUser = new Map<string, Pick[]>()
  for (const r of rosters ?? []) {
    const raw = Array.isArray(r.players) ? r.players[0] : r.players
    if (!raw) continue
    const player: PlayerLite = {
      id: raw.id,
      full_name: raw.full_name,
      country: raw.country,
      current_rank: raw.current_rank,
      ytd_points: ytdByPlayer.get(raw.id) ?? 0,
    }
    const arr = byUser.get(r.user_id) ?? []
    arr.push({ player, tier: r.tier })
    byUser.set(r.user_id, arr)
  }

  const standings = Array.from(byUser.entries())
    .map(([userId, picks]) => ({
      userId,
      name: memberByUser.get(userId) ?? userId.slice(0, 6),
      total: picks.reduce((s, p) => s + p.player.ytd_points, 0),
      picks,
    }))
    .sort((a, b) => b.total - a.total)

  const isAdmin = role === 'admin'
  const isActive = draft?.status === 'active'
  const isCompleted = draft?.status === 'completed'

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-10">
      <div className="flex items-baseline justify-between">
        <div>
          <Link href={`/leagues/${slug}`} className="text-sm text-neutral-500 hover:underline">
            ← {league.name}
          </Link>
          <h1 className="text-2xl font-semibold mt-1">
            {tour} Year-Long {league.season_year}
          </h1>
        </div>
        {(isAdmin || isActive) && (
          <Link
            href={`/leagues/${slug}/year-long/${tour.toLowerCase()}/draft`}
            className="rounded-md bg-black text-white px-3 py-1.5 text-sm dark:bg-white dark:text-black"
          >
            {isActive ? 'Open draft room' : isCompleted ? 'View draft' : 'Set up draft'}
          </Link>
        )}
      </div>

      {isAdmin && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <div className="text-xs text-neutral-500">
            Sync all {tour} {league.season_year} events from Sackmann (free, no API quota). Updates seeds, round_reached, and points_earned across the season.
          </div>
          <form action={syncSackmannYear}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="tour" value={tour} />
            <input type="hidden" name="year" value={league.season_year} />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
              Sync season scores
            </button>
          </form>
        </div>
      )}

      {sync && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Sackmann: {sync} tournaments · {syncRows} rows
          {syncNew && syncNew !== '0' ? ` · ${syncNew} new players` : ''}.
          {syncWiki && syncWiki !== '0' && (
            <>
              {' '}Wikipedia fallback: {syncWiki} tournaments · {syncWikiRows} rows.
            </>
          )}
        </div>
      )}

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Standings
        </h2>
        {standings.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No rosters yet. {isAdmin ? 'Set up the draft to begin.' : 'Waiting on the admin to start the draft.'}
          </p>
        ) : (
          <ol className="mt-4 space-y-4">
            {standings.map((row, i) => {
              const lead = standings[0].total
              const pct = lead > 0 ? Math.max(4, Math.round((row.total / lead) * 100)) : 0
              return (
                <li
                  key={row.userId}
                  className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-4 py-3 bg-neutral-50 dark:bg-neutral-900">
                    <span
                      className={
                        'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ' +
                        (i === 0
                          ? 'bg-yellow-400 text-black'
                          : i === 1
                            ? 'bg-neutral-300 text-black'
                            : i === 2
                              ? 'bg-amber-600 text-white'
                              : 'bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300')
                      }
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{row.name}</div>
                      <div className="mt-1 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-base sm:text-lg font-semibold tabular-nums">
                        {row.total.toLocaleString()}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-neutral-500">pts</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 text-xs">
                    {TIERS.map((tier) => {
                      const tierPicks = row.picks.filter((p) => p.tier === tier)
                      if (tierPicks.length === 0) return null
                      return (
                        <div key={tier}>
                          <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                            {tier}
                          </div>
                          <ul className="mt-1 space-y-0.5">
                            {tierPicks
                              .slice()
                              .sort((a, b) => b.player.ytd_points - a.player.ytd_points)
                              .map((p) => (
                                <li
                                  key={p.player.id}
                                  className="flex items-center gap-1.5"
                                >
                                  <span aria-hidden>{countryFlag(p.player.country)}</span>
                                  <span className="truncate flex-1">{p.player.full_name}</span>
                                  <span className="tabular-nums text-neutral-500">
                                    {p.player.ytd_points.toLocaleString()}
                                  </span>
                                  {row.userId === user.id && (
                                    <Link
                                      href={`/leagues/${slug}/year-long/${tour.toLowerCase()}/replace/${p.player.id}`}
                                      className="text-[10px] uppercase tracking-wide text-neutral-500 hover:underline ml-1"
                                    >
                                      replace
                                    </Link>
                                  )}
                                </li>
                              ))}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </main>
  )
}
