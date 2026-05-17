// Tournament-Scoring championship logic. Plan §2.2.

export const CATEGORY_WEIGHTS: Record<string, number> = {
  Slam: 10,
  Finals: 7,
  '1000': 6,
  '500': 3,
  '250': 2,
}

export type EventWin = {
  tournament_id: string
  tournament_name: string
  category: string
  weight: number
  user_id: string
  user_score: number
  // Number of users tied for the win (1 = solo).
  tie_count: number
}

export type ChampionshipRow = {
  user_id: string
  name: string
  total_score: number
  slam_wins: number
  finals_wins: number
  m1000_wins: number
  m500_wins: number
  m250_wins: number
  wins: EventWin[]
}

export function weightForCategory(category: string): number {
  return CATEGORY_WEIGHTS[category] ?? 0
}

type Pick = { tournament_id: string; user_id: string; player_id: string }
type EventScore = { tournament_id: string; player_id: string; points: number }
type Tourney = { id: string; name: string; category: string; status: string }
type Member = { user_id: string; name: string }

/**
 * Compute per-user weighted wins given:
 *  - league members
 *  - tournaments in scope (typically league_tournaments × completed-or-scored)
 *  - all tournament_picks for that league/tour scope
 *  - per (tournament,player) points_earned
 *
 * Tie rule: split the category weight equally among tied users.
 */
export function computeChampionship(
  members: Member[],
  tourneys: Tourney[],
  picks: Pick[],
  scores: EventScore[],
): ChampionshipRow[] {
  const scoreMap = new Map<string, number>()
  for (const s of scores) {
    scoreMap.set(`${s.tournament_id}|${s.player_id}`, s.points)
  }

  // (tournament -> user -> total)
  const eventUserTotals = new Map<string, Map<string, number>>()
  for (const p of picks) {
    const k = `${p.tournament_id}|${p.player_id}`
    const pts = scoreMap.get(k) ?? 0
    const inner = eventUserTotals.get(p.tournament_id) ?? new Map<string, number>()
    inner.set(p.user_id, (inner.get(p.user_id) ?? 0) + pts)
    eventUserTotals.set(p.tournament_id, inner)
  }

  const rows = new Map<string, ChampionshipRow>()
  for (const m of members) {
    rows.set(m.user_id, {
      user_id: m.user_id,
      name: m.name,
      total_score: 0,
      slam_wins: 0,
      finals_wins: 0,
      m1000_wins: 0,
      m500_wins: 0,
      m250_wins: 0,
      wins: [],
    })
  }

  for (const t of tourneys) {
    const userTotals = eventUserTotals.get(t.id)
    if (!userTotals || userTotals.size === 0) continue
    let max = -Infinity
    for (const v of userTotals.values()) if (v > max) max = v
    if (max <= 0) continue
    const winners = [...userTotals.entries()].filter(([, v]) => v === max)
    const weight = weightForCategory(t.category)
    if (weight === 0) continue
    const share = weight / winners.length
    for (const [uid, score] of winners) {
      const row = rows.get(uid)
      if (!row) continue
      row.total_score += share
      const winRecord: EventWin = {
        tournament_id: t.id,
        tournament_name: t.name,
        category: t.category,
        weight: share,
        user_id: uid,
        user_score: score,
        tie_count: winners.length,
      }
      row.wins.push(winRecord)
      const key = t.category
      if (key === 'Slam') row.slam_wins += 1 / winners.length
      else if (key === 'Finals') row.finals_wins += 1 / winners.length
      else if (key === '1000') row.m1000_wins += 1 / winners.length
      else if (key === '500') row.m500_wins += 1 / winners.length
      else if (key === '250') row.m250_wins += 1 / winners.length
    }
  }

  return [...rows.values()].sort((a, b) => b.total_score - a.total_score)
}
