'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { countryFlag } from '@/lib/flag'

type Member = { userId: string; name: string }
type DrawPlayer = {
  id: string
  full_name: string
  country: string | null
  current_rank: number | null
  seed: number | null
  tier: 'top8' | '9-16' | 'unseeded'
}
type Roster = {
  userId: string
  tier: string
  pickNumber: number | null
  player: { id: string; full_name: string; country: string | null }
}
type Draft = {
  id: string
  status: string
  pick_order: string[]
  current_pick: number
}
type SortKey = 'seed' | 'rank' | 'name'

const TIERS = ['top8', '9-16', 'unseeded'] as const

function whoseTurn(draft: Draft): { userId: string | null; round: number; idx: number } {
  const order = draft.pick_order
  const n = order.length
  if (!n) return { userId: null, round: 0, idx: 0 }
  const round = Math.floor(draft.current_pick / n)
  let idx = draft.current_pick % n
  if (round % 2 === 1) idx = n - 1 - idx
  return { userId: order[idx], round, idx }
}

export default function TournamentDraftRoom({
  tournamentId,
  leagueId,
  userId,
  members,
  initialDraft,
  initialRosters,
  pickConfig,
  draw,
}: {
  tournamentId: string
  leagueId: string
  userId: string
  members: Member[]
  initialDraft: Draft
  initialRosters: Roster[]
  pickConfig: { top8: number; '9-16': number; unseeded: number }
  draw: DrawPlayer[]
}) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [draft, setDraft] = useState<Draft>(normalizeDraft(initialDraft))
  const [rosters, setRosters] = useState<Roster[]>(initialRosters)
  const [pickedIds, setPickedIds] = useState<Set<string>>(
    new Set(initialRosters.map((r) => r.player.id))
  )
  const [activeTier, setActiveTier] = useState<(typeof TIERS)[number]>('top8')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('seed')
  const [error, setError] = useState<string | null>(null)
  const [showRoster, setShowRoster] = useState(false)
  const [pending, start] = useTransition()

  useEffect(() => {
    const ch = supabase
      .channel(`tdraft:${draft.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_drafts', filter: `id=eq.${draft.id}` },
        (payload) => {
          const next = payload.new as Record<string, unknown>
          if (next) {
            setDraft((d) => ({
              ...d,
              status: String(next.status),
              current_pick: Number(next.current_pick),
              pick_order: parseOrder(next.pick_order),
            }))
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tournament_picks',
          filter: `league_id=eq.${leagueId}`,
        },
        (payload) => {
          const r = payload.new as Record<string, unknown>
          if (String(r.tournament_id) !== tournamentId) return
          supabase
            .from('players')
            .select('id, full_name, country')
            .eq('id', String(r.player_id))
            .single()
            .then(({ data }) => {
              if (!data) return
              setRosters((rs) => [
                ...rs,
                {
                  userId: String(r.user_id),
                  tier: String(r.tier),
                  pickNumber: r.pick_number ? Number(r.pick_number) : null,
                  player: data,
                },
              ])
              setPickedIds((s) => new Set(s).add(data.id))
            })
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [supabase, draft.id, leagueId, tournamentId])

  const turn = whoseTurn(draft)
  const myTurn = turn.userId === userId && draft.status === 'active'
  const memberName = (uid: string | null) =>
    members.find((m) => m.userId === uid)?.name ?? uid?.slice(0, 6) ?? '—'

  const myPicks = rosters.filter((r) => r.userId === userId)
  const tierCounts: Record<string, number> = {}
  for (const r of myPicks) tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1

  const filtered = draw
    .filter(
      (p) =>
        p.tier === activeTier &&
        !pickedIds.has(p.id) &&
        (!search || p.full_name.toLowerCase().includes(search.toLowerCase()))
    )
    .slice()
    .sort((a, b) => {
      if (sortKey === 'name') return a.full_name.localeCompare(b.full_name)
      if (sortKey === 'rank') {
        return (a.current_rank ?? 99999) - (b.current_rank ?? 99999)
      }
      return (a.seed ?? 99999) - (b.seed ?? 99999)
    })

  const onPick = (player: DrawPlayer) => {
    setError(null)
    start(async () => {
      const { error } = await supabase.rpc('pick_tournament', {
        p_league: leagueId,
        p_tournament: tournamentId,
        p_player: player.id,
      })
      if (error) setError(error.message)
      else router.refresh()
    })
  }

  const pickNumberInRound = (draft.current_pick % Math.max(draft.pick_order.length, 1)) + 1
  const history = rosters.slice().reverse()

  return (
    <main className="max-w-5xl mx-auto pb-24">
      <div
        className={
          'sticky top-0 z-20 border-b backdrop-blur ' +
          (myTurn
            ? 'bg-emerald-500/15 border-emerald-500/40'
            : 'bg-white/80 dark:bg-neutral-950/80 border-neutral-200 dark:border-neutral-800')
        }
      >
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">
              round {turn.round + 1} · pick {pickNumberInRound}
            </div>
            <div className="text-sm sm:text-base font-semibold truncate">
              {draft.status === 'completed'
                ? 'Draft complete'
                : myTurn
                  ? "You're on the clock"
                  : `On the clock: ${memberName(turn.userId)}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowRoster((v) => !v)}
            className="lg:hidden rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs"
          >
            {showRoster ? 'Hide' : 'Rosters'}
          </button>
        </div>
        <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto text-[11px]">
          {draft.pick_order.map((uid, i) => (
            <span
              key={uid + i}
              className={
                'rounded px-2 py-0.5 whitespace-nowrap ' +
                (turn.userId === uid && draft.status === 'active'
                  ? 'bg-black text-white dark:bg-white dark:text-black'
                  : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400')
              }
            >
              {memberName(uid)}
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="px-4 mt-6 grid gap-8 lg:grid-cols-[1fr_320px]">
        <section>
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {TIERS.map((t) => {
              const cap = pickConfig[t] ?? 0
              const have = tierCounts[t] ?? 0
              const full = have >= cap
              return (
                <button
                  key={t}
                  onClick={() => setActiveTier(t)}
                  disabled={cap === 0}
                  className={
                    'rounded-full px-3 py-1 text-xs whitespace-nowrap ' +
                    (t === activeTier
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : cap === 0
                        ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-400 opacity-40'
                        : full
                          ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-400 line-through'
                          : 'bg-neutral-100 dark:bg-neutral-800')
                  }
                >
                  {t} <span className="opacity-60 ml-1 tabular-nums">{have}/{cap}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              type="search"
              placeholder="Search player"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-2 text-sm"
            >
              <option value="seed">Seed</option>
              <option value="rank">Rank</option>
              <option value="name">Name</option>
            </select>
          </div>

          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {filtered.slice(0, 200).map((p) => {
              const cap = pickConfig[activeTier] ?? 0
              const tierFull = (tierCounts[activeTier] ?? 0) >= cap
              return (
                <li key={p.id} className="py-3 flex items-center gap-3">
                  <span className="text-xl leading-none" aria-hidden>
                    {countryFlag(p.country) || '·'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{p.full_name}</div>
                    <div className="text-xs text-neutral-500 flex gap-2 mt-0.5">
                      {p.seed != null && <span className="tabular-nums">[{p.seed}]</span>}
                      {p.current_rank != null && (
                        <span className="tabular-nums">#{p.current_rank}</span>
                      )}
                      {p.country && <span>{p.country}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => onPick(p)}
                    disabled={!myTurn || pending || tierFull}
                    className="rounded-md bg-black text-white px-3 py-2 text-xs sm:text-sm disabled:opacity-30 dark:bg-white dark:text-black min-w-[64px]"
                  >
                    Pick
                  </button>
                </li>
              )
            })}
            {filtered.length === 0 && (
              <li className="py-6 text-sm text-neutral-500 text-center">
                No available players in this tier.
              </li>
            )}
          </ul>
        </section>

        <aside className={(showRoster ? 'block' : 'hidden') + ' lg:block space-y-6'}>
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Recent picks
            </h2>
            <ol className="mt-2 space-y-1 text-xs">
              {history.slice(0, 8).map((r, i) => (
                <li key={(r.pickNumber ?? '') + r.player.id} className="flex gap-2">
                  <span className="text-neutral-400 tabular-nums w-6">
                    #{r.pickNumber ?? rosters.length - i}
                  </span>
                  <span className="flex-1 truncate">
                    <span className="text-neutral-500">{memberName(r.userId)}:</span>{' '}
                    <span className="font-medium">{r.player.full_name}</span>
                  </span>
                  <span className="text-neutral-400">{r.tier}</span>
                </li>
              ))}
              {history.length === 0 && <li className="text-neutral-500">No picks yet.</li>}
            </ol>
          </div>

          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Rosters
            </h2>
            <div className="mt-2 space-y-3">
              {members.map((m) => {
                const picks = rosters.filter((r) => r.userId === m.userId)
                return (
                  <div
                    key={m.userId}
                    className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-medium text-sm">{m.name}</span>
                      <span className="text-xs text-neutral-500">{picks.length}</span>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-xs">
                      {picks.map((r) => (
                        <li key={r.player.id} className="flex gap-1.5">
                          <span aria-hidden>{countryFlag(r.player.country)}</span>
                          <span className="truncate flex-1">{r.player.full_name}</span>
                          <span className="text-neutral-400">{r.tier}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
      </div>
    </main>
  )
}

function normalizeDraft(d: Draft): Draft {
  return { ...d, pick_order: parseOrder(d.pick_order) }
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
