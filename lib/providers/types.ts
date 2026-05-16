export type Tour = 'ATP' | 'WTA'

export interface Tournament {
  externalId: string
  name: string
  tour: Tour
  category: string
  drawSize: number
  surface?: string
  startDate: string
  endDate: string
}

export interface PlayerEntry {
  playerExternalId: string
  fullName: string
  seed?: number
  status: 'entered' | 'withdrew' | 'active' | 'eliminated'
}

export interface Match {
  externalId: string
  round: string
  player1ExternalId: string
  player2ExternalId: string
  winnerExternalId?: string
  score?: string
  status: 'scheduled' | 'live' | 'completed' | 'walkover'
  scheduledAt?: string
  completedAt?: string
}

export interface RankingRow {
  playerExternalId: string
  fullName: string
  rank: number
  points: number
}

export interface DataProvider {
  listTournaments(year: number): Promise<Tournament[]>
  getDraw(tournamentExternalId: string): Promise<PlayerEntry[]>
  getMatches(tournamentExternalId: string): Promise<Match[]>
  getRankings(tour: Tour): Promise<RankingRow[]>
}
