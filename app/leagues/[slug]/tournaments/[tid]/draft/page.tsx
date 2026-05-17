import { notFound } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueAdmin, requireLeagueMember } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import PickOrderEditor from '@/components/PickOrderEditor'
import TournamentDraftRoom from '@/components/TournamentDraftRoom'

export const dynamic = 'force-dynamic'

async function startDraft(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tid = String(formData.get('tid'))
  const orderRaw = String(formData.get('order') ?? '')
  const order = orderRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (order.length < 1) throw new Error('Pick order is empty')
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()
  const { error } = await admin.rpc('start_tournament_draft', {
    p_league: league.id,
    p_tournament: tid,
    p_pick_order: order,
  })
  if (error) throw new Error(error.message)
  revalidatePath(`/leagues/${slug}/tournaments/${tid}/draft`)
}

export default async function TournamentDraftPage({
  params,
}: {
  params: Promise<{ slug: string; tid: string }>
}) {
  const { slug, tid } = await params
  const { league, user, role } = await requireLeagueMember(slug)
  const admin = createAdminClient()

  const [
    { data: tournament },
    { data: lt },
    { data: draft },
    { data: members },
    { data: picks },
    { data: drawRows },
  ] = await Promise.all([
    admin
      .from('tournaments')
      .select('id, name, tour, category, start_date')
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
        'user_id, tier, pick_number, players:players!tournament_picks_player_id_fkey(id, full_name, country)'
      )
      .eq('league_id', league.id)
      .eq('tournament_id', tid)
      .order('pick_number', { ascending: true }),
    admin
      .from('draw_with_tier')
      .select('player_id, full_name, country, current_rank, seed, tier')
      .eq('tournament_id', tid),
  ])

  if (!tournament || !lt) notFound()

  const memberRows = (members ?? []).map((m) => ({
    userId: m.user_id,
    name:
      (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.display_name ??
      m.user_id.slice(0, 6),
  }))

  if (!draft) {
    if (role !== 'admin') {
      return (
        <main className="max-w-md mx-auto px-4 py-12 text-center">
          <h1 className="text-xl font-semibold">Draft not started</h1>
          <p className="mt-2 text-sm text-neutral-500">
            Waiting on a league admin to set up the {tournament.name} draft.
          </p>
        </main>
      )
    }
    return (
      <main className="max-w-lg mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold">Set up {tournament.name} draft</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {tournament.tour} {tournament.category} · {tournament.start_date}
        </p>
        <PickOrderEditor
          members={memberRows}
          action={startDraft}
          hiddenFields={{ slug, tid }}
        />
      </main>
    )
  }

  const cfg = lt.pick_config as { top8: number; '9-16': number; unseeded: number }
  type DrawRow = {
    player_id: string
    full_name: string
    country: string | null
    current_rank: number | null
    seed: number | null
    tier: 'top8' | '9-16' | 'unseeded'
  }
  const draw = ((drawRows ?? []) as DrawRow[]).map((d) => ({
    id: d.player_id,
    full_name: d.full_name,
    country: d.country,
    current_rank: d.current_rank,
    seed: d.seed,
    tier: d.tier,
  }))

  return (
    <TournamentDraftRoom
      tournamentId={tid}
      leagueId={league.id}
      userId={user.id}
      members={memberRows}
      initialDraft={draft}
      initialRosters={(picks ?? [])
        .map((p) => ({
          userId: p.user_id,
          tier: p.tier,
          pickNumber: p.pick_number,
          player: Array.isArray(p.players) ? p.players[0] : p.players,
        }))
        .filter((r) => r.player) as {
        userId: string
        tier: string
        pickNumber: number | null
        player: { id: string; full_name: string; country: string | null }
      }[]}
      pickConfig={cfg}
      draw={draw}
    />
  )
}
