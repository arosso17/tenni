import type { Tour } from '../providers/types'

export interface PickScoreInput {
  tour: Tour
  category: string
  drawSize: number
  roundReached: string
  wasQualifier?: boolean
}

// Stub. Real tables encoded in atp_table.ts / wta_table.ts in M2.
export function pointsForRound(_input: PickScoreInput): number {
  throw new Error('TODO encode ATP/WTA scoring tables')
}
