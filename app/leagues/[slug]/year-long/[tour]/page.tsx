import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { countryFlag } from '@/lib/flag'

export const dynamic = 'force-dynamic'

const TIERS = ['1-8', '9-16', '17-32', '33-50', '51-100', '100+'] as const

export default async function YearLongPage({
  params,
}: {
  params: Promise<{ slug: string; tour: string }>
}) {
  const { slug, tour: tourParam } = await params
  const tour = tourParam.toUpperCase()
  if (tour !== 'ATP' && tour !== 'WTA') notFound()

  const { league, role } = await requireLeagueMember(slug)
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
      .select('user_id, tier, players:players!year_long_rosters_player_id_fkey(id, full_name, country, current_rank, current_season_points)')
      .eq('league_id', league.id)
      .eq('tour', tour),
  ])

  const memberByUser = new Map(
    (members ?? []).map((m) => [
      m.user_id,
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ?? m.user_id.slice(0, 6),
    ])
  )

  type Pick = { player: { id: string; full_name: string; country: string | null; current_rank: number | null; current_season_points: number | null }; tier: string }
  const byUser = new Map<string, Pick[]>()
  for (const r of rosters ?? []) {
    const player = Array.isArray(r.players) ? r.players[0] : r.players
    if (!player) continue
    const arr = byUser.get(r.user_id) ?? []
    arr.push({ player, tier: r.tier })
    byUser.set(r.user_id, arr)
  }

  const standings = Array.from(byUser.entries())
    .map(([userId, picks]) => ({
      userId,
      name: memberByUser.get(userId) ?? userId.slice(0, 6),
      total: picks.reduce((s, p) => s + (p.player.current_season_points ?? 0), 0),
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
                              .sort(
                                (a, b) =>
                                  (b.player.current_season_points ?? 0) -
                                  (a.player.current_season_points ?? 0)
                              )
                              .map((p) => (
                                <li
                                  key={p.player.id}
                                  className="flex items-center gap-1.5"
                                >
                                  <span aria-hidden>{countryFlag(p.player.country)}</span>
                                  <span className="truncate flex-1">{p.player.full_name}</span>
                                  <span className="tabular-nums text-neutral-500">
                                    {(p.player.current_season_points ?? 0).toLocaleString()}
                                  </span>
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
