import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { CATEGORY_WEIGHTS, computeChampionship } from '@/lib/championship'

export const dynamic = 'force-dynamic'

export default async function ChampionshipPage({
  params,
}: {
  params: Promise<{ slug: string; tour: string }>
}) {
  const { slug, tour: tourParam } = await params
  const tour = tourParam.toUpperCase() as 'ATP' | 'WTA'
  if (tour !== 'ATP' && tour !== 'WTA') notFound()

  const { league } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  // 1. League members + names.
  const { data: memberRows } = await admin
    .from('league_members')
    .select('user_id, profiles(display_name)')
    .eq('league_id', league.id)
  const members = (memberRows ?? []).map((m) => ({
    user_id: m.user_id,
    name:
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ??
      m.user_id.slice(0, 6),
  }))

  // 2. League's tournaments filtered to this tour.
  const { data: ltRows } = await admin
    .from('league_tournaments')
    .select('tournament_id, tournaments(id, name, tour, category, status)')
    .eq('league_id', league.id)
  const allTourneys = (ltRows ?? [])
    .map((r) => (Array.isArray(r.tournaments) ? r.tournaments[0] : r.tournaments))
    .filter((t): t is { id: string; name: string; tour: string; category: string; status: string } => !!t && t.tour === tour)
  const tournamentIds = allTourneys.map((t) => t.id)

  // 3. Picks + per-(event,player) points for those events.
  let picks: { tournament_id: string; user_id: string; player_id: string }[] = []
  let scores: { tournament_id: string; player_id: string; points: number }[] = []
  if (tournamentIds.length) {
    const [{ data: pickRows }, { data: ptRows }] = await Promise.all([
      admin
        .from('tournament_picks')
        .select('tournament_id, user_id, player_id')
        .eq('league_id', league.id)
        .in('tournament_id', tournamentIds),
      admin
        .from('player_tournaments')
        .select('tournament_id, player_id, points_earned')
        .in('tournament_id', tournamentIds),
    ])
    picks = pickRows ?? []
    scores = (ptRows ?? []).map((r) => ({
      tournament_id: r.tournament_id,
      player_id: r.player_id,
      points: r.points_earned ?? 0,
    }))
  }

  const standings = computeChampionship(
    members,
    allTourneys.map((t) => ({ id: t.id, name: t.name, category: t.category, status: t.status })),
    picks,
    scores,
  )

  const lead = standings[0]?.total_score ?? 0

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div>
        <Link href={`/leagues/${slug}`} className="text-sm text-neutral-500 hover:underline">
          ← {league.name}
        </Link>
        <h1 className="text-2xl font-semibold mt-1">{tour} Championship {league.season_year}</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Weighted tournament wins. Slam 10 · Finals 7 · 1000 6 · 500 3 · 250 2. Ties split the weight.
        </p>
      </div>

      <div className="flex gap-2 text-xs">
        {(['ATP', 'WTA'] as const).map((tr) => (
          <Link
            key={tr}
            href={`/leagues/${slug}/championship/${tr.toLowerCase()}`}
            className={
              'rounded-full px-3 py-1 ' +
              (tr === tour
                ? 'bg-black text-white dark:bg-white dark:text-black'
                : 'bg-neutral-100 dark:bg-neutral-800')
            }
          >
            {tr}
          </Link>
        ))}
      </div>

      <section>
        {standings.every((s) => s.total_score === 0) ? (
          <p className="text-sm text-neutral-500">
            No tournament winners yet. Standings populate once events complete and points_earned is loaded.
          </p>
        ) : (
          <ol className="space-y-3">
            {standings.map((row, i) => {
              const pct = lead > 0 ? Math.max(4, Math.round((row.total_score / lead) * 100)) : 0
              return (
                <li
                  key={row.user_id}
                  className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden"
                >
                  <div className="flex items-center gap-3 px-4 py-3 bg-neutral-50 dark:bg-neutral-900">
                    <span
                      className={
                        'h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ' +
                        (i === 0 && row.total_score > 0
                          ? 'bg-yellow-400 text-black'
                          : i === 1 && row.total_score > 0
                            ? 'bg-neutral-300 text-black'
                            : i === 2 && row.total_score > 0
                              ? 'bg-amber-600 text-white'
                              : 'bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300')
                      }
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{row.name}</div>
                      <div className="mt-1 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-base sm:text-lg font-semibold tabular-nums">
                        {fmt(row.total_score)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-neutral-500">pts</div>
                    </div>
                  </div>

                  <div className="px-4 py-3 text-xs grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1 text-neutral-500">
                    <span>Slam: <span className="text-neutral-900 dark:text-neutral-100 tabular-nums">{fmt(row.slam_wins)}</span></span>
                    <span>Finals: <span className="text-neutral-900 dark:text-neutral-100 tabular-nums">{fmt(row.finals_wins)}</span></span>
                    <span>1000: <span className="text-neutral-900 dark:text-neutral-100 tabular-nums">{fmt(row.m1000_wins)}</span></span>
                    <span>500: <span className="text-neutral-900 dark:text-neutral-100 tabular-nums">{fmt(row.m500_wins)}</span></span>
                    <span>250: <span className="text-neutral-900 dark:text-neutral-100 tabular-nums">{fmt(row.m250_wins)}</span></span>
                  </div>

                  {row.wins.length > 0 && (
                    <ul className="px-4 pb-3 text-xs space-y-0.5">
                      {row.wins.map((w) => (
                        <li key={w.tournament_id + w.user_id} className="flex gap-2">
                          <span className="text-neutral-500">
                            +{fmt(w.weight)} ({w.category}{w.tie_count > 1 ? ` · tie ${w.tie_count}` : ''}):
                          </span>
                          <Link
                            href={`/leagues/${slug}/tournaments/${w.tournament_id}`}
                            className="font-medium hover:underline truncate"
                          >
                            {w.tournament_name}
                          </Link>
                          <span className="ml-auto tabular-nums text-neutral-500">
                            {w.user_score.toLocaleString()} pts
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ol>
        )}

        <div className="mt-6 text-[10px] text-neutral-500">
          Categories: {Object.entries(CATEGORY_WEIGHTS).map(([k, v]) => `${k}=${v}`).join(' · ')}
        </div>
      </section>
    </main>
  )
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  return n.toFixed(1)
}
