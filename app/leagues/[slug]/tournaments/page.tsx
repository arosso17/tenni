import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { defaultPickConfig } from '@/lib/pickConfig'

export const dynamic = 'force-dynamic'

async function castWeekVote(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const pollId = String(formData.get('poll_id'))
  const choice = String(formData.get('choice'))
  const { league, user } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const { data: poll } = await admin
    .from('week_polls')
    .select('id, options, votes, winner_tournament_id')
    .eq('id', pollId)
    .eq('league_id', league.id)
    .maybeSingle()
  if (!poll || poll.winner_tournament_id) {
    redirect(`/leagues/${slug}/tournaments`)
  }
  const options = (poll.options ?? []) as string[]
  if (!options.includes(choice)) {
    redirect(`/leagues/${slug}/tournaments`)
  }
  const votes = { ...((poll.votes ?? {}) as Record<string, string>), [user.id]: choice }
  await admin.from('week_polls').update({ votes }).eq('id', poll.id)

  revalidatePath(`/leagues/${slug}/tournaments`)
  redirect(`/leagues/${slug}/tournaments`)
}

async function resolveOpenPolls(leagueId: string, year: number) {
  const admin = createAdminClient()
  const nowIso = new Date().toISOString()
  const { data: openPolls } = await admin
    .from('week_polls')
    .select('id, week_start, tour, options, votes, closes_at')
    .eq('league_id', leagueId)
    .is('winner_tournament_id', null)
  if (!openPolls || openPolls.length === 0) return

  // Need member count for "all voted" detection.
  const { data: members } = await admin
    .from('league_members')
    .select('user_id')
    .eq('league_id', leagueId)
  const memberCount = (members ?? []).length

  for (const p of openPolls) {
    const options = (p.options ?? []) as string[]
    const votes = (p.votes ?? {}) as Record<string, string>
    const voteCount = Object.keys(votes).length
    const closed = p.closes_at && p.closes_at < nowIso
    const allVoted = memberCount > 0 && voteCount >= memberCount
    if (!closed && !allVoted) continue

    // Tally.
    const tally: Record<string, number> = {}
    for (const tid of Object.values(votes)) tally[tid] = (tally[tid] ?? 0) + 1
    let winner: string | null = null
    let max = 0
    for (const tid of options) {
      const c = tally[tid] ?? 0
      if (c > max) {
        max = c
        winner = tid
      }
    }
    if (!winner || max === 0) {
      // No votes — pick option with earliest start date.
      const { data: opts } = await admin
        .from('tournaments')
        .select('id, start_date')
        .in('id', options)
        .order('start_date', { ascending: true })
      winner = opts?.[0]?.id ?? options[0]
    }

    await admin.from('week_polls').update({ winner_tournament_id: winner }).eq('id', p.id)

    // Insert winner into league_tournaments if not already there.
    const exists = await admin
      .from('league_tournaments')
      .select('tournament_id')
      .eq('league_id', leagueId)
      .eq('tournament_id', winner)
      .maybeSingle()
    if (!exists.data) {
      const { data: t } = await admin
        .from('tournaments')
        .select('category, start_date')
        .eq('id', winner)
        .maybeSingle()
      if (t) {
        await admin.from('league_tournaments').insert({
          league_id: leagueId,
          tournament_id: winner,
          pick_config: defaultPickConfig(t.category),
          picks_lock_at: t.start_date ? new Date(`${t.start_date}T00:00:00Z`).toISOString() : null,
        })
      }
    }
  }
  void year
}

export default async function LeagueTournamentsPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const { league, role, user } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  // Auto-resolve any polls that are closed or fully voted.
  await resolveOpenPolls(league.id, league.season_year)

  const [{ data: rows }, { data: drafts }, { data: pendingPolls }] = await Promise.all([
    admin
      .from('league_tournaments')
      .select(
        'tournament_id, pick_config, picks_lock_at, tournaments(name, tour, category, start_date, end_date, status)'
      )
      .eq('league_id', league.id)
      .order('picks_lock_at', { ascending: true }),
    admin
      .from('tournament_drafts')
      .select('tournament_id, status')
      .eq('league_id', league.id),
    admin
      .from('week_polls')
      .select('id, week_start, tour, options, votes, closes_at')
      .eq('league_id', league.id)
      .is('winner_tournament_id', null)
      .order('week_start', { ascending: true }),
  ])
  const draftStatusByTid = new Map(
    (drafts ?? []).map((d) => [d.tournament_id, d.status])
  )

  // Resolve poll option tournament metadata (names) in one query.
  const optionIds = Array.from(
    new Set((pendingPolls ?? []).flatMap((p) => (p.options as string[]) ?? [])),
  )
  let optionMeta = new Map<string, { name: string; category: string; start_date: string }>()
  if (optionIds.length) {
    const { data: opts } = await admin
      .from('tournaments')
      .select('id, name, category, start_date')
      .in('id', optionIds)
    optionMeta = new Map((opts ?? []).map((o) => [o.id, o]))
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <Link href={`/leagues/${slug}`} className="text-sm text-neutral-500 hover:underline">
            ← {league.name}
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Tournaments</h1>
        </div>
        {role === 'admin' && (
          <Link
            href={`/leagues/${slug}/admin/tournaments`}
            className="text-sm underline"
          >
            Manage
          </Link>
        )}
      </div>

      {pendingPolls && pendingPolls.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
            Week polls
          </h2>
          <p className="text-xs text-neutral-500">
            Multiple {pendingPolls[0]?.tour} events the same week — vote for which one the league plays.
            Auto-resolves when all members vote or the week starts.
          </p>
          <ul className="space-y-3">
            {pendingPolls.map((p) => {
              const votes = (p.votes ?? {}) as Record<string, string>
              const myVote = votes[user.id]
              const tally: Record<string, number> = {}
              for (const tid of Object.values(votes)) tally[tid] = (tally[tid] ?? 0) + 1
              const totalVotes = Object.keys(votes).length
              return (
                <li
                  key={p.id}
                  className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">
                      {p.tour} · week of {p.week_start}
                    </span>
                    <span className="text-xs text-neutral-500">{totalVotes} vote{totalVotes === 1 ? '' : 's'}</span>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {((p.options as string[]) ?? []).map((tid) => {
                      const t = optionMeta.get(tid)
                      const count = tally[tid] ?? 0
                      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
                      const picked = myVote === tid
                      return (
                        <li key={tid} className="flex items-center gap-3">
                          <form action={castWeekVote} className="flex items-center gap-3 flex-1">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="poll_id" value={p.id} />
                            <input type="hidden" name="choice" value={tid} />
                            <button
                              type="submit"
                              className={
                                'flex-1 text-left rounded-md border px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 ' +
                                (picked
                                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
                                  : 'border-neutral-200 dark:border-neutral-800')
                              }
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="font-medium truncate">{t?.name ?? tid.slice(0, 8)}</span>
                                <span className="text-xs text-neutral-500 tabular-nums">
                                  {count} · {pct}%
                                </span>
                              </div>
                              {t && (
                                <div className="text-xs text-neutral-500 mt-0.5">
                                  {t.category} · {t.start_date}
                                </div>
                              )}
                            </button>
                          </form>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {(!rows || rows.length === 0) ? (
        <p className="text-sm text-neutral-500">
          No tournaments yet.{' '}
          {role === 'admin' && (
            <Link href={`/leagues/${slug}/admin/tournaments`} className="underline">
              Add some
            </Link>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((row) => {
            const t = Array.isArray(row.tournaments) ? row.tournaments[0] : row.tournaments
            const draftStatus = draftStatusByTid.get(row.tournament_id) ?? 'pending'
            const label =
              t?.status === 'completed'
                ? 'Final'
                : t?.status === 'live'
                  ? 'Live'
                  : draftStatus === 'active'
                    ? 'Drafting'
                    : draftStatus === 'completed'
                      ? 'Drafted'
                      : 'Upcoming'
            return (
              <li key={row.tournament_id} className="py-3">
                <Link
                  href={`/leagues/${slug}/tournaments/${row.tournament_id}`}
                  className="flex items-center justify-between gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-900 -mx-2 px-2 py-1 rounded"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{t?.name}</div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {t?.tour} {t?.category} · {t?.start_date}
                    </div>
                  </div>
                  <span
                    className={
                      'text-[10px] uppercase tracking-wide rounded px-2 py-0.5 ' +
                      (label === 'Live'
                        ? 'bg-red-500/20 text-red-600 dark:text-red-300'
                        : label === 'Drafting'
                          ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300'
                          : 'bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400')
                    }
                  >
                    {label}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
