import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { slugify } from '@/lib/slug'
import { defaultPickConfig } from '@/lib/pickConfig'

export const dynamic = 'force-dynamic'

function weekStartOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const offset = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}

async function seedSeason(leagueId: string, year: number) {
  const admin = createAdminClient()
  const { data: tournaments } = await admin
    .from('tournaments')
    .select('id, name, tour, category, start_date, week_start')
    .gte('start_date', `${year}-01-01`)
    .lte('start_date', `${year}-12-31`)
    .order('start_date', { ascending: true })

  type T = { id: string; name: string; tour: string; category: string; start_date: string; week_start: string | null }
  const groups = new Map<string, T[]>()
  for (const t of (tournaments ?? []) as T[]) {
    const week = t.week_start ?? weekStartOf(t.start_date)
    const key = `${t.tour}|${week}`
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  for (const [key, evs] of groups) {
    const [, weekStr] = key.split('|')
    if (evs.length === 1) {
      const t = evs[0]
      await admin.from('league_tournaments').upsert({
        league_id: leagueId,
        tournament_id: t.id,
        pick_config: defaultPickConfig(t.category),
        picks_lock_at: t.start_date ? new Date(`${t.start_date}T00:00:00Z`).toISOString() : null,
      })
    } else {
      await admin.from('week_polls').upsert(
        {
          league_id: leagueId,
          week_start: weekStr,
          tour: evs[0].tour,
          options: evs.map((e) => e.id),
          closes_at: new Date(`${weekStr}T00:00:00Z`).toISOString(),
        },
        { onConflict: 'league_id,week_start,tour' },
      )
    }
  }
}

async function createLeague(formData: FormData) {
  'use server'
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const name = String(formData.get('name') ?? '').trim()
  const seasonYear = Number(formData.get('season_year') ?? new Date().getFullYear())
  if (!name) throw new Error('Name required')

  const admin = createAdminClient()

  // Ensure profile exists (safety net for users who signed up before the trigger existed).
  await admin.from('profiles').upsert(
    {
      id: user.id,
      display_name:
        (user.user_metadata?.full_name as string | undefined) ??
        (user.user_metadata?.name as string | undefined) ??
        user.email ??
        'Player',
      avatar_url: (user.user_metadata?.avatar_url as string | undefined) ?? null,
    },
    { onConflict: 'id' }
  )

  const baseSlug = slugify(name)
  let slug = baseSlug
  let attempt = 0
  while (attempt < 5) {
    const { data: existing } = await admin
      .from('leagues')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()
    if (!existing) break
    attempt++
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`
  }

  const { data: league, error } = await admin
    .from('leagues')
    .insert({
      name,
      slug,
      creator_id: user.id,
      season_year: seasonYear,
      season_start: `${seasonYear}-01-01`,
      season_end: `${seasonYear}-12-31`,
    })
    .select('id, slug')
    .single()
  if (error || !league) throw new Error(error?.message ?? 'Create failed')

  await admin.from('league_members').insert({
    league_id: league.id,
    user_id: user.id,
    role: 'admin',
  })

  if (formData.get('seed_season')) {
    await seedSeason(league.id, seasonYear)
  }

  redirect(`/leagues/${league.slug}`)
}

export default async function NewLeaguePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  return (
    <main className="max-w-md mx-auto px-4 py-8">
      <Link href="/leagues" className="text-sm text-neutral-500 hover:underline">
        ← Your leagues
      </Link>
      <h1 className="text-2xl font-semibold mt-2">New league</h1>
      <form action={createLeague} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">League name</label>
          <input
            name="name"
            required
            maxLength={80}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
            placeholder="The Big Three"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Season year</label>
          <input
            name="season_year"
            type="number"
            defaultValue={new Date().getFullYear()}
            min={2024}
            max={2100}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="seed_season"
            defaultChecked
            className="mt-0.5"
          />
          <span>
            Add all season tournaments now
            <span className="block text-xs text-neutral-500 mt-0.5">
              Single-event weeks added directly; same-week conflicts become member polls. You can change this later in admin.
            </span>
          </span>
        </label>
        <button
          type="submit"
          className="w-full rounded-md bg-black text-white py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
        >
          Create
        </button>
      </form>
    </main>
  )
}
