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

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'x-rapidapi-key': KEY,
      'x-rapidapi-host': HOST,
    },
    next: { revalidate: 60 * 15 }, // 15-min cache
  })
  if (!res.ok) throw new Error(`MatchStat ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

// Endpoint paths to be mapped to MatchStat docs as we wire each up (M2).
export class MatchStatProvider implements DataProvider {
  async listTournaments(_year: number): Promise<Tournament[]> {
    throw new Error('TODO map MatchStat tournaments endpoint')
  }
  async getDraw(_id: string): Promise<PlayerEntry[]> {
    throw new Error('TODO map MatchStat draw endpoint')
  }
  async getMatches(_id: string): Promise<Match[]> {
    throw new Error('TODO map MatchStat fixtures endpoint')
  }
  async getRankings(_tour: Tour): Promise<RankingRow[]> {
    throw new Error('TODO map MatchStat rankings endpoint')
  }
}
