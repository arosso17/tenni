import Link from 'next/link'
import { requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export default async function LeagueTournamentsPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const { league, role } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const [{ data: rows }, { data: drafts }] = await Promise.all([
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
  ])
  const draftStatusByTid = new Map(
    (drafts ?? []).map((d) => [d.tournament_id, d.status])
  )

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
