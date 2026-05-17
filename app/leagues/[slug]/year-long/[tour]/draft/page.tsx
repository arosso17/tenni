import { notFound } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueAdmin, requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import DraftRoom from '@/components/DraftRoom'
import PickOrderEditor from '@/components/PickOrderEditor'

export const dynamic = 'force-dynamic'

async function startDraft(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tour = String(formData.get('tour'))
  if (tour !== 'ATP' && tour !== 'WTA') return
  const orderRaw = String(formData.get('order') ?? '')
  const order = orderRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (order.length < 1) throw new Error('Pick order is empty')
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()
  const { error } = await admin.rpc('start_year_long_draft', {
    p_league: league.id,
    p_tour: tour,
    p_pick_order: order,
  })
  if (error) throw new Error(error.message)
  revalidatePath(`/leagues/${slug}/year-long/${tour.toLowerCase()}/draft`)
}

export default async function DraftPage({
  params,
}: {
  params: Promise<{ slug: string; tour: string }>
}) {
  const { slug, tour: tourParam } = await params
  const tour = tourParam.toUpperCase() as 'ATP' | 'WTA'
  if (tour !== 'ATP' && tour !== 'WTA') notFound()

  const { league, user, role } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const [{ data: draft }, { data: members }, { data: rosters }, { data: players }] =
    await Promise.all([
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
        .select('user_id, tier, player_id, drafted_at, players:players!year_long_rosters_player_id_fkey(id, full_name, country, current_rank, current_season_points)')
        .eq('league_id', league.id)
        .eq('tour', tour)
        .order('drafted_at', { ascending: true }),
      admin
        .from('players_with_tier')
        .select('id, full_name, country, current_rank, current_season_points, tier')
        .eq('tour', tour)
        .order('current_rank', { ascending: true, nullsFirst: false })
        .limit(500),
    ])

  const memberRows = (members ?? []).map((m) => ({
    userId: m.user_id,
    name:
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ??
      m.user_id.slice(0, 6),
  }))

  // No draft yet: show admin setup form (or wait message for non-admins).
  if (!draft) {
    if (role !== 'admin') {
      return (
        <main className="max-w-md mx-auto px-4 py-12 text-center">
          <h1 className="text-xl font-semibold">Draft not started</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Waiting on a league admin to set up the {tour} year-long draft.
          </p>
        </main>
      )
    }
    return (
      <main className="max-w-lg mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold">Set up {tour} year-long draft</h1>
        <PickOrderEditor
          members={memberRows}
          action={startDraft}
          hiddenFields={{ slug, tour }}
        />
      </main>
    )
  }

  // Active or completed draft: render the room.
  const drafted = new Set((rosters ?? []).map((r) => r.player_id))
  const available = (players ?? []).filter((p) => !drafted.has(p.id))

  return (
    <DraftRoom
      slug={slug}
      tour={tour}
      leagueId={league.id}
      userId={user.id}
      members={memberRows}
      initialDraft={draft}
      initialRosters={(rosters ?? []).map((r) => ({
        userId: r.user_id,
        tier: r.tier,
        draftedAt: r.drafted_at,
        player: Array.isArray(r.players) ? r.players[0] : r.players,
      })).filter((r) => r.player)}
      availablePlayers={available}
    />
  )
}
