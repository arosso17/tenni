// Sackmann match-CSV ingest. TS port of scripts/load_sackmann_draws.py.
// Downloads the year's match CSV for one tour, returns per-player aggregates
// (seed, round reached, points_earned) for one matched tournament.

import scoringPoints from '@/data/scoring_points.json'

type Tour = 'ATP' | 'WTA'

export type SackmannEntry = {
  name: string
  country: string | null
  seed: number | null
  round_reached: string
  points_earned: number
}

const SOURCES: Record<Tour, string> = {
  ATP: 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_{year}.csv',
  WTA: 'https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_{year}.csv',
}

const ROUND_RANK: Record<string, number> = {
  R128: 1, R64: 2, R32: 3, R16: 4, QF: 5, SF: 6, F: 7, W: 8, RR: 3, BR: 4,
}

const NEXT_ROUND: Record<string, string> = {
  R128: 'R64', R64: 'R32', R32: 'R16', R16: 'QF', QF: 'SF', SF: 'F', F: 'W', RR: 'SF',
}

// Sackmann name → list of equivalents (cities, sponsor names, country names).
// Comparison is normalized (lowercased, punctuation stripped).
const TOURNAMENT_ALIASES: Record<string, string[]> = {
  'roland garros': ['french open'],
  'wimbledon': ['the championships'],
  'atp finals': ['nitto atp finals', 'tour finals'],
  'acapulco': ['mexican open', 'abierto mexicano'],
  'rio de janeiro': ['rio open'],
  'santiago': ['chile open'],
  'doha': ['qatar open', 'qatar exxonmobil'],
  'munich': ['bmw open'],
  'bucharest': ['tiriac open', 'romanian open'],
  'buenos aires': ['argentina open'],
  'houston': ['us mens clay court', 'fayez sarofim'],
  'marrakech': ['grand prix hassan ii', 'morocco open'],
  'montpellier': ['open sud de france', 'open occitanie'],
  'rome': ['italian open', 'internazionali bnl', 'rome masters'],
  'monte carlo': ['monte carlo masters'],
  'indian wells': ['indian wells masters', 'bnp paribas open'],
  'miami': ['miami masters'],
  'madrid': ['madrid masters', 'mutua madrid'],
  'cincinnati': ['western southern', 'cincinnati masters'],
  'shanghai': ['shanghai masters', 'rolex shanghai'],
  'paris': ['paris masters', 'rolex paris'],
  'canadian open': ['national bank open', 'rogers cup', 'canada masters', 'toronto masters', 'montreal masters'],
}

// Words to drop from a tournament name before comparing, so "Madrid Masters" ↔
// "Madrid Open" both reduce to "madrid".
const STOPWORDS = new Set([
  'open', 'masters', 'championship', 'championships', 'cup', 'international',
  'tournament', 'finals', 'final', 'tour', 'classic', 'atp', 'wta', 'itf',
  'tennis', 'mens', 'womens', 'singles', 'the', 'de', 'la', 'le',
  'grand', 'slam', 'qualifying', 'qualifier',
])

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function coreTokens(s: string): Set<string> {
  return new Set(
    normalizeName(s)
      .split(' ')
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  )
}

function hasIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true
  return false
}

function tournamentMatches(sackmannName: string, dbName: string): boolean {
  const a = normalizeName(sackmannName)
  const b = normalizeName(dbName)
  if (!a || !b) return false
  if (a === b) return true

  // Direct alias lookup either direction.
  const aliasOf = (name: string): string[] => {
    const out: string[] = [name]
    for (const [canonical, alts] of Object.entries(TOURNAMENT_ALIASES)) {
      if (name === canonical || alts.includes(name)) out.push(canonical, ...alts)
    }
    return out
  }
  const aAliases = aliasOf(a)
  const bAliases = aliasOf(b)
  for (const ax of aAliases) {
    for (const bx of bAliases) {
      if (ax === bx) return true
    }
  }

  // Token-overlap match on core (after stripping Open/Masters/etc.).
  const aCore = coreTokens(a)
  const bCore = coreTokens(b)
  if (aCore.size > 0 && bCore.size > 0 && hasIntersect(aCore, bCore)) return true

  return false
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') {
        inQuote = false
      } else {
        cur += c
      }
    } else {
      if (c === ',') {
        out.push(cur)
        cur = ''
      } else if (c === '"') {
        inQuote = true
      } else {
        cur += c
      }
    }
  }
  out.push(cur)
  return out
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = parseCsvLine(lines[0])
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const r: Record<string, string> = {}
    headers.forEach((h, j) => (r[h] = cols[j] ?? ''))
    rows.push(r)
  }
  return { headers, rows }
}

async function fetchCsv(tour: Tour, year: number): Promise<Record<string, string>[]> {
  const url = SOURCES[tour].replace('{year}', String(year))
  const r = await fetch(url, {
    headers: { 'User-Agent': 'TenniFantasy/0.1 (alrevs13@gmail.com)' },
    cache: 'no-store',
  })
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`Sackmann ${tour} ${year}: ${r.status}`)
  const { rows } = parseCsv(await r.text())
  return rows
}

function parseSeed(raw: string | undefined): number | null {
  if (!raw) return null
  const s = raw.trim()
  return /^\d+$/.test(s) ? parseInt(s, 10) : null
}

function computeReached(matches: Record<string, string>[], name: string): string {
  let best: string | null = null
  let wonFinal = false
  for (const m of matches) {
    if (m.winner_name !== name && m.loser_name !== name) continue
    const r = m.round
    if (!ROUND_RANK[r]) continue
    if (best === null || ROUND_RANK[r] > ROUND_RANK[best]) best = r
    if (r === 'F' && m.winner_name === name) wonFinal = true
  }
  if (wonFinal) return 'W'
  if (!best) return ''
  // Promote if they won at that round.
  const wonAt = matches.some((m) => m.round === best && m.winner_name === name)
  return wonAt ? NEXT_ROUND[best] ?? best : best
}

function lookupPoints(tour: Tour, category: string, reached: string): number {
  if (!reached) return 0
  const points = scoringPoints as unknown as Record<string, Record<string, Record<string, number>>>
  const table = points[tour]?.[category]
  if (!table) return 0
  return table[reached] ?? 0
}

function aggregateBlock(matches: Record<string, string>[], tour: Tour, category: string): SackmannEntry[] {
  type Agg = { name: string; country: string | null; seed: number | null }
  const players = new Map<string, Agg>()
  for (const m of matches) {
    for (const who of ['winner', 'loser'] as const) {
      const name = (m[`${who}_name`] ?? '').trim()
      if (!name) continue
      const ioc = ((m[`${who}_ioc`] ?? '').trim() || null) as string | null
      const seed = parseSeed(m[`${who}_seed`])
      const existing = players.get(name)
      if (!existing) {
        players.set(name, { name, country: ioc, seed })
      } else {
        if (seed != null && existing.seed == null) existing.seed = seed
        if (ioc && !existing.country) existing.country = ioc
      }
    }
  }
  const entries: SackmannEntry[] = []
  for (const p of players.values()) {
    const reached = computeReached(matches, p.name)
    entries.push({
      name: p.name,
      country: p.country,
      seed: p.seed,
      round_reached: reached,
      points_earned: lookupPoints(tour, category, reached),
    })
  }
  return entries
}

/**
 * Pull this year's Sackmann CSV for the given tour, find the block of matches
 * for the named tournament, and return per-player aggregates with points
 * computed via scoring_points.json for the given category.
 */
export async function scrapeSackmannEvent(
  year: number,
  tour: Tour,
  tournamentName: string,
  category: string,
): Promise<{ matched: boolean; sackmannName: string | null; entries: SackmannEntry[] }> {
  const rows = await fetchCsv(tour, year)
  if (rows.length === 0) return { matched: false, sackmannName: null, entries: [] }

  const blocks = new Map<string, Record<string, string>[]>()
  const names = new Map<string, string>()
  for (const r of rows) {
    const tid = r.tourney_id ?? ''
    if (!blocks.has(tid)) {
      blocks.set(tid, [])
      names.set(tid, r.tourney_name ?? '')
    }
    blocks.get(tid)!.push(r)
  }

  let matchedTid: string | null = null
  for (const [tid] of blocks) {
    if (tournamentMatches(names.get(tid) ?? '', tournamentName)) {
      matchedTid = tid
      break
    }
  }
  if (!matchedTid) return { matched: false, sackmannName: null, entries: [] }

  const entries = aggregateBlock(blocks.get(matchedTid)!, tour, category)
  return { matched: true, sackmannName: names.get(matchedTid) ?? null, entries }
}

export type YearMatch = {
  sackmannName: string
  tournamentName: string
  category: string
  entries: SackmannEntry[]
}

/**
 * Pull this year's CSV and return one aggregate per CSV block that fuzzy-matches
 * a row in `dbTournaments`. Caller decides how to persist.
 */
export async function scrapeSackmannYear(
  year: number,
  tour: Tour,
  dbTournaments: Array<{ id: string; name: string; category: string }>,
): Promise<Array<{ tournamentId: string } & YearMatch>> {
  const rows = await fetchCsv(tour, year)
  if (rows.length === 0) return []

  const blocks = new Map<string, Record<string, string>[]>()
  const names = new Map<string, string>()
  for (const r of rows) {
    const tid = r.tourney_id ?? ''
    if (!blocks.has(tid)) {
      blocks.set(tid, [])
      names.set(tid, r.tourney_name ?? '')
    }
    blocks.get(tid)!.push(r)
  }

  const matched: Array<{ tournamentId: string } & YearMatch> = []
  const usedDbIds = new Set<string>()
  for (const [tid, matches] of blocks) {
    const sname = names.get(tid) ?? ''
    const hit = dbTournaments.find(
      (db) => !usedDbIds.has(db.id) && tournamentMatches(sname, db.name),
    )
    if (!hit) continue
    usedDbIds.add(hit.id)
    matched.push({
      tournamentId: hit.id,
      sackmannName: sname,
      tournamentName: hit.name,
      category: hit.category,
      entries: aggregateBlock(matches, tour, hit.category),
    })
  }
  return matched
}
