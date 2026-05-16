'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Tour = 'ATP' | 'WTA'
type Member = { userId: string; name: string }
type Player = {
  id: string
  full_name: string
  current_rank: number | null
  current_season_points: number | null
  tier?: string
}
type Roster = { userId: string; tier: string; player: Player }
type Draft = {
  id: string
  status: string
  pick_order: string[]
  current_pick: number
  tier_quota: Record<string, number>
}

const TIERS = ['1-8', '9-16', '17-32', '33-50', '51-100', '100+'] as const

function whoseTurn(draft: Draft): { userId: string | null; round: number; idx: number } {
  const order = draft.pick_order
  const n = order.length
  if (!n) return { userId: null, round: 0, idx: 0 }
  const round = Math.floor(draft.current_pick / n)
  let idx = draft.current_pick % n
  if (round % 2 === 1) idx = n - 1 - idx
  return { userId: order[idx], round, idx }
}

export default function DraftRoom({
  slug,
  tour,
  leagueId,
  userId,
  members,
  initialDraft,
  initialRosters,
  availablePlayers,
}: {
  slug: string
  tour: Tour
  leagueId: string
  userId: string
  members: Member[]
  initialDraft: Draft
  initialRosters: Roster[]
  availablePlayers: Player[]
}) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [draft, setDraft] = useState<Draft>(normalizeDraft(initialDraft))
  const [rosters, setRosters] = useState<Roster[]>(initialRosters)
  const [available, setAvailable] = useState<Player[]>(availablePlayers)
  const [activeTier, setActiveTier] = useState<(typeof TIERS)[number]>('1-8')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // Realtime subscriptions.
  useEffect(() => {
    const ch = supabase
      .channel(`draft:${draft.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'year_long_drafts', filter: `id=eq.${draft.id}` },
        (payload) => {
          const next = payload.new as Record<string, unknown>
          if (next && typeof next === 'object') {
            setDraft((d) => ({
              ...d,
              status: String(next.status),
              current_pick: Number(next.current_pick),
              pick_order: parseOrder(next.pick_order),
              tier_quota: parseQuota(next.tier_quota),
            }))
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'year_long_rosters',
          filter: `league_id=eq.${leagueId}`,
        },
        (payload) => {
          const r = payload.new as Record<string, unknown>
          if (String(r.tour) !== tour) return
          // Pull the player row, then add to roster + drop from available.
          supabase
            .from('players')
            .select('id, full_name, current_rank, current_season_points')
            .eq('id', String(r.player_id))
            .single()
            .then(({ data }) => {
              if (!data) return
              setRosters((rs) => [
                ...rs,
                { userId: String(r.user_id), tier: String(r.tier), player: data },
              ])
              setAvailable((av) => av.filter((p) => p.id !== data.id))
            })
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [supabase, draft.id, leagueId, tour])

  const turn = whoseTurn(draft)
  const myTurn = turn.userId === userId && draft.status === 'active'
  const memberName = (uid: string | null) =>
    members.find((m) => m.userId === uid)?.name ?? uid?.slice(0, 6) ?? '—'

  const myPicks = rosters.filter((r) => r.userId === userId)
  const tierCounts: Record<string, number> = {}
  for (const r of myPicks) tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1

  const filteredAvailable = available.filter(
    (p) =>
      (p.tier ?? rankToTier(p.current_rank)) === activeTier &&
      (!search || p.full_name.toLowerCase().includes(search.toLowerCase()))
  )

  const onPick = (player: Player) => {
    setError(null)
    start(async () => {
      const { error } = await supabase.rpc('pick_year_long', {
        p_league: leagueId,
        p_tour: tour,
        p_player: player.id,
      })
      if (error) {
        setError(error.message)
      } else {
        router.refresh()
      }
    })
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">
            {tour} Year-Long Draft
          </h1>
          <p className="text-sm text-neutral-500">
            {draft.status === 'completed'
              ? 'Draft complete.'
              : myTurn
                ? "It's your pick."
                : `On the clock: ${memberName(turn.userId)}`}
            {' · '}Round {turn.round + 1}, pick {(draft.current_pick % draft.pick_order.length) + 1}
          </p>
        </div>
        <div className="text-xs text-neutral-500 flex flex-wrap gap-2">
          {draft.pick_order.map((uid, i) => (
            <span
              key={uid + i}
              className={
                'rounded px-2 py-0.5 ' +
                (turn.userId === uid && draft.status === 'active'
                  ? 'bg-black text-white dark:bg-white dark:text-black'
                  : 'bg-neutral-100 dark:bg-neutral-800')
              }
            >
              {memberName(uid)}
            </span>
          ))}
        </div>
      </header>

      {error && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          <div className="flex items-center gap-2 flex-wrap">
            {TIERS.map((t) => {
              const cap = draft.tier_quota[t] ?? 0
              const have = tierCounts[t] ?? 0
              return (
                <button
                  key={t}
                  onClick={() => setActiveTier(t)}
                  className={
                    'rounded-md px-2.5 py-1 text-xs ' +
                    (t === activeTier
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : 'bg-neutral-100 dark:bg-neutral-800')
                  }
                >
                  {t} <span className="opacity-60">{have}/{cap}</span>
                </button>
              )
            })}
          </div>
          <input
            type="search"
            placeholder="search player"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mt-3 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {filteredAvailable.slice(0, 100).map((p) => {
              const cap = draft.tier_quota[activeTier] ?? 0
              const tierFull = (tierCounts[activeTier] ?? 0) >= cap
              return (
                <li key={p.id} className="py-2 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{p.full_name}</span>
                    <span className="ml-2 text-xs text-neutral-500">
                      #{p.current_rank ?? '?'} · {(p.current_season_points ?? 0).toLocaleString()} pts
                    </span>
                  </div>
                  <button
                    onClick={() => onPick(p)}
                    disabled={!myTurn || pending || tierFull}
                    className="rounded bg-black text-white px-2.5 py-1 text-xs disabled:opacity-30 dark:bg-white dark:text-black"
                  >
                    pick
                  </button>
                </li>
              )
            })}
            {filteredAvailable.length === 0 && (
              <li className="py-3 text-sm text-neutral-500">No available players in this tier.</li>
            )}
          </ul>
        </section>

        <aside>
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Rosters</h2>
          <div className="mt-3 space-y-4">
            {members.map((m) => {
              const picks = rosters.filter((r) => r.userId === m.userId)
              return (
                <div key={m.userId} className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium text-sm">{m.name}</span>
                    <span className="text-xs text-neutral-500">{picks.length} picks</span>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {picks.map((r) => (
                      <li key={r.player.id}>
                        <span className="text-neutral-500">{r.tier}:</span> {r.player.full_name}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    </main>
  )
}

function rankToTier(rank: number | null): string {
  if (rank == null) return '100+'
  if (rank <= 8) return '1-8'
  if (rank <= 16) return '9-16'
  if (rank <= 32) return '17-32'
  if (rank <= 50) return '33-50'
  if (rank <= 100) return '51-100'
  return '100+'
}

function normalizeDraft(d: Draft): Draft {
  return {
    ...d,
    pick_order: parseOrder(d.pick_order),
    tier_quota: parseQuota(d.tier_quota),
  }
}

function parseOrder(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === 'string') {
    try {
      const v = JSON.parse(value)
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  return []
}

function parseQuota(value: unknown): Record<string, number> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, number>
  }
  if (typeof value === 'string') {
    try {
      const v = JSON.parse(value)
      if (v && typeof v === 'object') return v
    } catch {}
  }
  return { '1-8': 2, '9-16': 2, '17-32': 2, '33-50': 3, '51-100': 3, '100+': 3 }
}
