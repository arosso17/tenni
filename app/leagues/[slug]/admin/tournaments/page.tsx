import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireLeagueAdmin } from '@/lib/auth'
import { defaultPickConfig, totalPicks } from '@/lib/pickConfig'
import PickConfigEditor from '@/components/PickConfigEditor'

export const dynamic = 'force-dynamic'

async function addTournament(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tournamentId = String(formData.get('tournament_id'))
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const { data: t } = await admin
    .from('tournaments')
    .select('category, end_date')
    .eq('id', tournamentId)
    .single()
  if (!t) return

  const cfg = defaultPickConfig(t.category)
  await admin.from('league_tournaments').upsert({
    league_id: league.id,
    tournament_id: tournamentId,
    pick_config: cfg,
    picks_lock_at: t.end_date ? new Date(`${t.end_date}T00:00:00Z`).toISOString() : null,
  })
  revalidatePath(`/leagues/${slug}/admin/tournaments`)
}

async function removeTournament(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tournamentId = String(formData.get('tournament_id'))
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()
  await admin
    .from('league_tournaments')
    .delete()
    .eq('league_id', league.id)
    .eq('tournament_id', tournamentId)
  revalidatePath(`/leagues/${slug}/admin/tournaments`)
}

async function updatePickConfig(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tournamentId = String(formData.get('tournament_id'))
  const cfg = {
    top8: Number(formData.get('top8') ?? 0),
    '9-16': Number(formData.get('9-16') ?? 0),
    unseeded: Number(formData.get('unseeded') ?? 0),
  }
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()
  await admin
    .from('league_tournaments')
    .update({ pick_config: cfg })
    .eq('league_id', league.id)
    .eq('tournament_id', tournamentId)
  revalidatePath(`/leagues/${slug}/admin/tournaments`)
}

export default async function LeagueTournamentsAdmin({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ q?: string; year?: string }>
}) {
  const { slug } = await params
  const { q, year } = await searchParams
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const [{ data: selected }, catalog] = await Promise.all([
    admin
      .from('league_tournaments')
      .select('tournament_id, pick_config, picks_lock_at, tournaments(name, tour, category, start_date, end_date)')
      .eq('league_id', league.id)
      .order('picks_lock_at', { ascending: true }),
    (async () => {
      let query = admin
        .from('tournaments')
        .select('id, name, tour, category, start_date, end_date')
        .order('start_date', { ascending: true })
        .limit(80)
      if (q) query = query.ilike('name', `%${q}%`)
      if (year) query = query.gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`)
      return query
    })(),
  ])

  const selectedIds = new Set((selected ?? []).map((s) => s.tournament_id))

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-12">
      <div>
        <Link href={`/leagues/${slug}/admin`} className="text-sm text-neutral-500 hover:underline">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold mt-2">{league.name} — Tournaments</h1>
      </div>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">In this league</h2>
        {(!selected || selected.length === 0) ? (
          <p className="mt-3 text-sm text-neutral-500">No tournaments selected yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {selected.map((row) => {
              const t = Array.isArray(row.tournaments) ? row.tournaments[0] : row.tournaments
              const cfg = row.pick_config as { top8: number; '9-16': number; unseeded: number }
              return (
                <li key={row.tournament_id} className="py-4">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <span className="font-medium">{t?.name}</span>
                      <span className="ml-2 text-xs text-neutral-500">
                        {t?.tour} {t?.category} · {t?.start_date}
                      </span>
                    </div>
                    <form action={removeTournament}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="tournament_id" value={row.tournament_id} />
                      <button className="text-xs text-red-500 hover:underline">remove</button>
                    </form>
                  </div>
                  <PickConfigEditor
                    slug={slug}
                    tournamentId={row.tournament_id}
                    initial={cfg}
                    action={updatePickConfig}
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Total picks: {totalPicks(cfg)}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Tournament catalog
        </h2>
        <form className="mt-3 flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ''}
            placeholder="search by name"
            className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          <input
            name="year"
            defaultValue={year ?? String(league.season_year)}
            className="w-24 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          <button className="rounded-md bg-neutral-200 dark:bg-neutral-800 px-3 text-sm">
            Filter
          </button>
        </form>

        <ul className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
          {(catalog.data ?? []).map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between text-sm">
              <div>
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-xs text-neutral-500">
                  {t.tour} {t.category} · {t.start_date}
                </span>
              </div>
              {selectedIds.has(t.id) ? (
                <span className="text-xs text-neutral-500">in league</span>
              ) : (
                <form action={addTournament}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="tournament_id" value={t.id} />
                  <button className="text-xs underline">add</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
