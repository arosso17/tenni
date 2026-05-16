import type {
  DataProvider,
  Tournament,
  PlayerEntry,
  Match,
  RankingRow,
  Tour,
} from './types'

const BASE = process.env.TENNIS_API_BASE_URL!
const KEY = process.env.RAPIDAPI_KEY!
const HOST = process.env.RAPIDAPI_HOST!

async function call<T>(path: string, init?: { revalidate?: number }): Promise<T> {
  if (!KEY) throw new Error('RAPIDAPI_KEY missing')
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'x-rapidapi-key': KEY,
      'x-rapidapi-host': HOST,
    },
    next: { revalidate: init?.revalidate ?? 60 * 15 },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MatchStat ${path} -> ${res.status} ${body.slice(0, 120)}`)
  }
  return res.json() as Promise<T>
}

type RankingsResponse = {
  data: Array<{
    point: number
    position: number
    player: {
      id: number
      name: string
      currentRank: number
      points: number
      country?: { name?: string; acronym?: string }
    }
  }>
}

type CalendarResponse = {
  data: Array<{
    id: number
    name: string
    tier?: string // "ATP 1000", "ATP Masters 1000", "Finals", "Grand Slam"
    draw_size?: number | null
    date: string // week start
    court?: { name?: string }
    coutry?: { name?: string; acronym?: string } // sic — typo in API
  }>
}

export class MatchStatProvider implements DataProvider {
  async getRankings(tour: Tour): Promise<RankingRow[]> {
    const t = tour.toLowerCase()
    const json = await call<RankingsResponse>(`/${t}/ranking/singles`, {
      revalidate: 60 * 60 * 24,
    })
    return json.data.map((r) => ({
      playerExternalId: String(r.player.id),
      fullName: r.player.name,
      rank: r.position ?? r.player.currentRank,
      points: r.point ?? r.player.points,
    }))
  }

  async listTournaments(year: number): Promise<Tournament[]> {
    const out: Tournament[] = []
    const seen = new Set<string>()
    const MAX_PAGES = 20 // safety cap (40 calls max for both tours)
    for (const tour of ['atp', 'wta'] as const) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const json = await call<CalendarResponse>(
          `/${tour}/tournament/calendar/${year}?page=${page}`,
          { revalidate: 60 * 60 * 24 * 7 }
        )
        if (!json.data || json.data.length === 0) break
        let added = 0
        for (const t of json.data) {
          const externalId = `${tour}-${t.id}`
          if (seen.has(externalId)) continue
          seen.add(externalId)
          const start = t.date.slice(0, 10)
          out.push({
            externalId,
            name: t.name,
            tour: tour.toUpperCase() as Tour,
            category: parseCategory(t.tier ?? ''),
            drawSize: t.draw_size ?? 0,
            surface: parseSurface(t.court?.name),
            startDate: start,
            endDate: addDays(start, 6),
          })
          added++
        }
        if (added === 0) break // page returned only duplicates → done
      }
    }
    return out
  }

  async getDraw(_externalId: string): Promise<PlayerEntry[]> {
    // Mapped via /tournament/results/{seasonid}; deferred until M3 needs it.
    throw new Error('TODO map MatchStat tournament draw endpoint')
  }

  async getMatches(_externalId: string): Promise<Match[]> {
    // Mapped via /fixtures or /tournament/results/{seasonid}; deferred.
    throw new Error('TODO map MatchStat fixtures endpoint')
  }
}

function parseCategory(raw: string): string {
  const u = (raw ?? '').toUpperCase()
  if (!u) return 'Other'
  if (u.includes('GRAND SLAM')) return 'Slam'
  if (u.includes('FINALS')) return 'Finals'
  const m = u.match(/(\d{3,4})/)
  return m ? m[1] : raw
}

function parseSurface(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const u = raw.toLowerCase()
  if (u.includes('clay')) return 'clay'
  if (u.includes('grass')) return 'grass'
  if (u.includes('hard')) return 'hard'
  return raw
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
