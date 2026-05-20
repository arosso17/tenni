import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { countryFlag } from '@/lib/flag'

export const dynamic = 'force-dynamic'

async function submitReplace(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tour = String(formData.get('tour'))
  const oldId = String(formData.get('old_id'))
  const newId = String(formData.get('new_id'))
  if (tour !== 'ATP' && tour !== 'WTA') return
  const { league } = await requireLeagueMember(slug)
  const supabase = await createClient()
  const { error } = await supabase.rpc('replace_year_long', {
    p_league: league.id,
    p_tour: tour,
    p_old: oldId,
    p_new: newId,
  })
  if (error) {
    redirect(
      `/leagues/${slug}/year-long/${tour.toLowerCase()}/replace/${oldId}?err=${encodeURIComponent(error.message)}`,
    )
  }
  revalidatePath(`/leagues/${slug}/year-long/${tour.toLowerCase()}`)
  redirect(`/leagues/${slug}/year-long/${tour.toLowerCase()}`)
}

export default async function YearLongReplacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; tour: string; pid: string }>
  searchParams: Promise<{ q?: string; err?: string }>
}) {
  const { slug, tour: tourParam, pid } = await params
  const { q, err } = await searchParams
  const tour = tourParam.toUpperCase() as 'ATP' | 'WTA'
  if (tour !== 'ATP' && tour !== 'WTA') notFound()

  const { league, user } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  // Verify caller owns this pick.
  const { data: ownership } = await admin
    .from('year_long_rosters')
    .select('player_id, tier, players:players!year_long_rosters_player_id_fkey(id, full_name, country, current_rank)')
    .eq('league_id', league.id)
    .eq('user_id', user.id)
    .eq('tour', tour)
    .eq('player_id', pid)
    .is('replaced_by', null)
    .maybeSingle()
  if (!ownership) notFound()

  const oldPlayer = Array.isArray(ownership.players) ? ownership.players[0] : ownership.players
  const tier = ownership.tier

  // Active picks across all members in this league/tour — to exclude from candidates.
  const { data: taken } = await admin
    .from('year_long_rosters')
    .select('player_id')
    .eq('league_id', league.id)
    .eq('tour', tour)
    .is('replaced_by', null)
  const takenIds = new Set((taken ?? []).map((r) => r.player_id))

  // Same-tier candidates from players_with_tier view.
  let query = admin
    .from('players_with_tier')
    .select('id, full_name, country, current_rank, current_season_points, tier')
    .eq('tour', tour)
    .eq('tier', tier)
    .order('current_rank', { ascending: true, nullsFirst: false })
    .limit(200)
  if (q) query = query.ilike('full_name', `%${q}%`)
  const { data: candidates } = await query

  const available = (candidates ?? []).filter((c) => !takenIds.has(c.id))

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <div>
        <Link
          href={`/leagues/${slug}/year-long/${tour.toLowerCase()}`}
          className="text-sm text-neutral-500 hover:underline"
        >
          ← {tour} year-long
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Replace pick</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Swapping <span className="font-medium">{oldPlayer?.full_name}</span> ({tier} tier). Replacement
          must be in the same tier.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {err}
        </div>
      )}

      <form method="get" className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search candidates"
          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-neutral-200 dark:bg-neutral-800 px-3 text-sm">Search</button>
      </form>

      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {available.map((p) => (
          <li key={p.id} className="py-3 flex items-center gap-3">
            <span className="text-xl leading-none" aria-hidden>
              {countryFlag(p.country) || '·'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate">{p.full_name}</div>
              <div className="text-xs text-neutral-500 mt-0.5">
                #{p.current_rank ?? '?'} · {p.country ?? ''}
              </div>
            </div>
            <form action={submitReplace}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="tour" value={tour} />
              <input type="hidden" name="old_id" value={pid} />
              <input type="hidden" name="new_id" value={p.id} />
              <button
                type="submit"
                className="rounded-md bg-black text-white px-3 py-1.5 text-xs dark:bg-white dark:text-black"
              >
                Replace
              </button>
            </form>
          </li>
        ))}
        {available.length === 0 && (
          <li className="py-6 text-sm text-neutral-500 text-center">
            No same-tier candidates available.
          </li>
        )}
      </ul>
    </main>
  )
}
