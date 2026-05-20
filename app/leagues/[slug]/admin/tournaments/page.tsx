import Link from 'next/link'
import { redirect } from 'next/navigation'
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
    .select('category, start_date')
    .eq('id', tournamentId)
    .single()
  if (!t) return

  const cfg = defaultPickConfig(t.category)
  await admin.from('league_tournaments').upsert({
    league_id: league.id,
    tournament_id: tournamentId,
    pick_config: cfg,
    picks_lock_at: t.start_date ? new Date(`${t.start_date}T00:00:00Z`).toISOString() : null,
  })
  revalidatePath(`/leagues/${slug}/admin/tournaments`)
}

async function addFullSeason(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()
  const year = league.season_year

  const { data: tournaments } = await admin
    .from('tournaments')
    .select('id, name, tour, category, start_date, week_start')
    .gte('start_date', `${year}-01-01`)
    .lte('start_date', `${year}-12-31`)
    .order('start_date', { ascending: true })

  // Group by (tour, week_start). Fallback: derive week_start from start_date if null.
  type T = { id: string; name: string; tour: string; category: string; start_date: string; week_start: string | null }
  const groups = new Map<string, T[]>()
  for (const t of (tournaments ?? []) as T[]) {
    const week = t.week_start ?? weekStartOf(t.start_date)
    const key = `${t.tour}|${week}`
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  let added = 0
  let pollsCreated = 0
  for (const [key, evs] of groups) {
    const [, weekStr] = key.split('|')
    if (evs.length === 1) {
      const t = evs[0]
      const exists = await admin
        .from('league_tournaments')
        .select('tournament_id')
        .eq('league_id', league.id)
        .eq('tournament_id', t.id)
        .maybeSingle()
      if (exists.data) continue
      const cfg = defaultPickConfig(t.category)
      await admin.from('league_tournaments').insert({
        league_id: league.id,
        tournament_id: t.id,
        pick_config: cfg,
        picks_lock_at: t.start_date ? new Date(`${t.start_date}T00:00:00Z`).toISOString() : null,
      })
      added++
    } else {
      // Skip poll creation if any of these events is already in the league or already won a poll.
      const tIds = evs.map((e) => e.id)
      const { data: alreadyIn } = await admin
        .from('league_tournaments')
        .select('tournament_id')
        .eq('league_id', league.id)
        .in('tournament_id', tIds)
      if ((alreadyIn ?? []).length > 0) continue

      // Closes Mon 00:00 UTC of the conflict week.
      const closesAt = new Date(`${weekStr}T00:00:00Z`).toISOString()
      await admin.from('week_polls').upsert(
        {
          league_id: league.id,
          week_start: weekStr,
          tour: evs[0].tour,
          options: tIds,
          closes_at: closesAt,
        },
        { onConflict: 'league_id,week_start,tour' },
      )
      pollsCreated++
    }
  }

  revalidatePath(`/leagues/${slug}/admin/tournaments`)
  revalidatePath(`/leagues/${slug}/tournaments`)
  redirect(`/leagues/${slug}/admin/tournaments?bulk=${added}&polls=${pollsCreated}`)
}

function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const day = d.getUTCDay() // 0=Sun
  const offset = (day + 6) % 7
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
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
  searchParams: Promise<{ q?: string; year?: string; bulk?: string; polls?: string }>
}) {
  const { slug } = await params
  const { q, year, bulk, polls } = await searchParams
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const [{ data: selected }, catalog] = await Promise.all([
    admin
      .from('league_tournaments')
      .select('tournament_id, pick_config, picks_lock_at, tournaments(name, tour, category, start_date, end_date)')
      .eq('league_id', league.id)
      .order('picks_lock_at', { ascending: true }),
    (async () => {
      const filterYear = year ?? String(league.season_year)
      let query = admin
        .from('tournaments')
        .select('id, name, tour, category, start_date, end_date')
        .order('start_date', { ascending: true })
        .limit(80)
      if (q) query = query.ilike('name', `%${q}%`)
      query = query.gte('start_date', `${filterYear}-01-01`).lte('start_date', `${filterYear}-12-31`)
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

      {bulk && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Added {bulk} tournaments directly.
          {polls && polls !== '0' && (
            <> Created {polls} week poll{polls === '1' ? '' : 's'} for same-week conflicts — members vote on{' '}
              <Link href={`/leagues/${slug}/tournaments`} className="underline">the tournaments page</Link>.
            </>
          )}
        </div>
      )}

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Add full season
        </h2>
        <p className="mt-2 text-xs text-neutral-500">
          Adds every {league.season_year} event. Single-event weeks are added directly. Conflict weeks
          (multiple ATP or multiple WTA events same week) become member polls — majority wins.
        </p>
        <form action={addFullSeason} className="mt-3">
          <input type="hidden" name="slug" value={slug} />
          <button
            type="submit"
            className="rounded-md bg-black text-white px-4 py-2 text-sm dark:bg-white dark:text-black"
          >
            Add all {league.season_year} tournaments
          </button>
        </form>
      </section>

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
