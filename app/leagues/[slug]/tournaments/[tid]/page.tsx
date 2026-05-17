import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { countryFlag } from '@/lib/flag'

export const dynamic = 'force-dynamic'

const TIERS = ['top8', '9-16', 'unseeded'] as const

export default async function LeagueTournamentPage({
  params,
}: {
  params: Promise<{ slug: string; tid: string }>
}) {
  const { slug, tid } = await params
  const { league, role } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const [
    { data: tournament },
    { data: lt },
    { data: draft },
    { data: members },
    { data: picks },
  ] = await Promise.all([
    admin
      .from('tournaments')
      .select('id, name, tour, category, start_date, end_date, status')
      .eq('id', tid)
      .maybeSingle(),
    admin
      .from('league_tournaments')
      .select('pick_config, picks_lock_at')
      .eq('league_id', league.id)
      .eq('tournament_id', tid)
      .maybeSingle(),
    admin
      .from('tournament_drafts')
      .select('id, status, pick_order, current_pick')
      .eq('league_id', league.id)
      .eq('tournament_id', tid)
      .maybeSingle(),
    admin
      .from('league_members')
      .select('user_id, profiles(display_name)')
      .eq('league_id', league.id),
    admin
      .from('tournament_picks')
      .select(
        'user_id, tier, pick_number, player_id, players:players!tournament_picks_player_id_fkey(id, full_name, country)'
      )
      .eq('league_id', league.id)
      .eq('tournament_id', tid)
      .order('pick_number', { ascending: true }),
  ])

  if (!tournament || !lt) notFound()

  // Points-earned lookup for picked players at this event.
  const playerIds = Array.from(
    new Set((picks ?? []).map((p) => p.player_id).filter(Boolean) as string[])
  )
  let pointsByPlayer = new Map<string, number>()
  if (playerIds.length) {
    const { data: pt } = await admin
      .from('player_tournaments')
      .select('player_id, points_earned')
      .eq('tournament_id', tid)
      .in('player_id', playerIds)
    pointsByPlayer = new Map(
      (pt ?? []).map((r) => [r.player_id, r.points_earned ?? 0])
    )
  }

  const memberByUser = new Map(
    (members ?? []).map((m) => [
      m.user_id,
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ??
        m.user_id.slice(0, 6),
    ])
  )

  type Pick = {
    player: { id: string; full_name: string; country: string | null }
    tier: string
    points: number
  }
  const byUser = new Map<string, Pick[]>()
  for (const r of picks ?? []) {
    const player = Array.isArray(r.players) ? r.players[0] : r.players
    if (!player) continue
    const arr = byUser.get(r.user_id) ?? []
    arr.push({
      player,
      tier: r.tier,
      points: pointsByPlayer.get(player.id) ?? 0,
    })
    byUser.set(r.user_id, arr)
  }

  const standings = (members ?? [])
    .map((m) => {
      const userPicks = byUser.get(m.user_id) ?? []
      return {
        userId: m.user_id,
        name: memberByUser.get(m.user_id) ?? m.user_id.slice(0, 6),
        total: userPicks.reduce((s, p) => s + p.points, 0),
        picks: userPicks,
      }
    })
    .sort((a, b) => b.total - a.total)

  const draftStatus = draft?.status ?? 'pending'
  const lead = standings[0]?.total ?? 0

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div>
        <Link
          href={`/leagues/${slug}/tournaments`}
          className="text-sm text-neutral-500 hover:underline"
        >
          ← Tournaments
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">{tournament.name}</h1>
            <p className="text-sm text-neutral-500 mt-1">
              {tournament.tour} {tournament.category} · {tournament.start_date}
              {tournament.end_date ? ` – ${tournament.end_date}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {role === 'admin' && (
              <Link
                href={`/leagues/${slug}/tournaments/${tid}/admin`}
                className="text-sm underline"
              >
                Manage draw
              </Link>
            )}
            {(role === 'admin' || draftStatus === 'active') && (
              <Link
                href={`/leagues/${slug}/tournaments/${tid}/draft`}
                className="rounded-md bg-black text-white px-3 py-1.5 text-sm dark:bg-white dark:text-black"
              >
                {draftStatus === 'active'
                  ? 'Open draft room'
                  : draftStatus === 'completed'
                    ? 'View draft'
                    : 'Set up draft'}
              </Link>
            )}
          </div>
        </div>
        {lt.picks_lock_at && (
          <p className="text-xs text-neutral-500 mt-2">
            Picks lock at {new Date(lt.picks_lock_at).toLocaleString()}
          </p>
        )}
      </div>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Standings
        </h2>
        {standings.every((s) => s.picks.length === 0) ? (
          <p className="mt-3 text-sm text-neutral-500">
            No picks yet.{' '}
            {role === 'admin' && draftStatus === 'pending' && 'Set up the draft to start.'}
          </p>
        ) : (
          <ol className="mt-4 space-y-3">
            {standings.map((row, i) => {
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
                        (i === 0 && row.total > 0
                          ? 'bg-yellow-400 text-black'
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
                        {row.total.toLocaleString()}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-neutral-500">pts</div>
                    </div>
                  </div>

                  {row.picks.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 px-4 py-3 text-xs">
                      {TIERS.map((tier) => {
                        const t = row.picks.filter((p) => p.tier === tier)
                        if (t.length === 0) return null
                        return (
                          <div key={tier}>
                            <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                              {tier}
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {t.map((p) => (
                                <li key={p.player.id} className="flex items-center gap-1.5">
                                  <span aria-hidden>{countryFlag(p.player.country)}</span>
                                  <span className="truncate flex-1">{p.player.full_name}</span>
                                  <span className="tabular-nums text-neutral-500">
                                    {p.points.toLocaleString()}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </main>
  )
}
