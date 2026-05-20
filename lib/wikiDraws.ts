// Wikipedia per-event draw scraper. TS port of scripts/load_wiki_draws.py.
// Fetches the singles draw article, extracts seeded entries from the Seeds
// section (handles both `#` lists and `{{seeds|N|...}}` templates), and pulls
// remaining entries from `{{NNTeamBracket}}` templates under ==Draw==.

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const UA = 'TenniFantasy/0.1 (alrevs13@gmail.com)'

type Tour = 'ATP' | 'WTA'

export type DrawEntry = { name: string; seed: number | null; country: string | null }
export type ResultEntry = DrawEntry & { round_reached: string; points_earned: number }

// Round progression: winning a match at key advances to the value.
const NEXT_ROUND: Record<string, string> = {
  R128: 'R64', R64: 'R32', R32: 'R16', R16: 'QF', QF: 'SF', SF: 'F', F: 'W',
}
const ROUND_RANK: Record<string, number> = {
  R128: 1, R64: 2, R32: 3, R16: 4, QF: 5, SF: 6, F: 7, W: 8, RR: 3,
}

const FLAG_RE = /\{\{\s*(?:flag(?:icon|athlete)?|flagIOC|flagICOteam)\s*\|\s*([A-Z]{3})\b/i
const LINK_RE = /\[\[([^|\]\n]+?)(?:\|[^\]\n]+?)?\]\]/
const SEEDS_TPL_RE = /\{\{\s*seeds\s*\|\s*(\d+)\s*(?:\|[^}]*)?\}\}/i

async function wikiSearch(query: string): Promise<string[]> {
  const titles: string[] = []
  for (const ns of [0, 118]) {
    const url = `${WIKI_API}?action=opensearch&search=${encodeURIComponent(query)}&limit=8&namespace=${ns}&format=json`
    const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' })
    if (!r.ok) continue
    const data = (await r.json()) as unknown[]
    if (Array.isArray(data) && Array.isArray(data[1])) {
      titles.push(...(data[1] as string[]))
    }
  }
  return titles
}

async function wikiParse(title: string): Promise<string | null> {
  const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&redirects=1`
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' })
  if (!r.ok) return null
  const j = (await r.json()) as { parse?: { wikitext?: { ['*']?: string } } }
  return j.parse?.wikitext?.['*'] ?? null
}

async function findArticle(year: number, name: string, tour: 'ATP' | 'WTA'): Promise<string | null> {
  const gender = tour === 'ATP' ? "Men's" : "Women's"
  const queries = [
    `${year} ${name} – ${gender} singles`,
    `${year} ${name} ${gender} singles`,
    `${year} ${name} singles`,
  ]
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const q of queries) {
    const titles = await wikiSearch(q)
    for (const title of titles) {
      if (seen.has(title)) continue
      seen.add(title)
      const low = title.toLowerCase()
      if (!low.includes('singles')) continue
      if (!title.includes(String(year))) continue
      if (low.includes('doubles') || low.includes('qualifying')) continue
      // Wrong-gender singles for the other tour — reject. Use word-boundary
      // patterns so "men's" doesn't also match "women's" via substring.
      const isMens = /\b(?:men's|gentlemen)\b/.test(low)
      const isWomens = /\b(?:women's|ladies)\b/.test(low)
      if (tour === 'ATP' && isWomens) continue
      if (tour === 'WTA' && isMens) continue
      candidates.push(title)
    }
  }
  // Prefer gendered title (clearest match for two-tour events).
  for (const c of candidates) {
    const low = c.toLowerCase()
    if (tour === 'ATP' && /\b(?:men's|gentlemen)\b/.test(low)) return c
    if (tour === 'WTA' && /\b(?:women's|ladies)\b/.test(low)) return c
  }
  // Fall back to a single-tour "Singles" article (Geneva, Hamburg, etc.).
  return candidates[0] ?? null
}

function stripDisambig(name: string): string {
  // Wikipedia link targets often include `(tennis)`, `(tennis player)`,
  // `(disambiguation)` suffixes. Strip a single trailing `(...)` chunk.
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

function parsePlayer(team: string): { name: string | null; country: string | null } {
  if (!team) return { name: null, country: null }
  const flag = team.match(FLAG_RE)
  const country = flag ? flag[1].toUpperCase() : null
  const link = team.match(LINK_RE)
  if (link) return { name: stripDisambig(link[1].trim()), country }
  const cleaned = team
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/'/g, '')
    .trim()
  return { name: stripDisambig(cleaned) || null, country }
}

function maskInnerPipes(text: string): string {
  let out = ''
  let dBrace = 0
  let dBrack = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1] ?? ''
    if (c === '{' && n === '{') {
      dBrace++
      out += '{{'
      i += 2
      continue
    }
    if (c === '}' && n === '}') {
      dBrace = Math.max(0, dBrace - 1)
      out += '}}'
      i += 2
      continue
    }
    if (c === '[' && n === '[') {
      dBrack++
      out += '[['
      i += 2
      continue
    }
    if (c === ']' && n === ']') {
      dBrack = Math.max(0, dBrack - 1)
      out += ']]'
      i += 2
      continue
    }
    if (c === '|' && (dBrace >= 2 || dBrack >= 1)) {
      out += '\x00'
    } else {
      out += c
    }
    i++
  }
  return out
}

function findTemplateBlocks(text: string, nameRe: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < text.length - 1) {
    if (text[i] === '{' && text[i + 1] === '{') {
      const slice = text.slice(i + 2, i + 200)
      if (nameRe.test(slice)) {
        let depth = 1
        let j = i + 2
        while (j < text.length - 1 && depth > 0) {
          if (text[j] === '{' && text[j + 1] === '{') {
            depth++
            j += 2
          } else if (text[j] === '}' && text[j + 1] === '}') {
            depth--
            j += 2
          } else {
            j++
          }
        }
        spans.push([i, j])
        i = j
        continue
      }
    }
    i++
  }
  return spans
}

function scopeToMainDraw(text: string): string {
  const startRe = /^==\s*(?:Singles\s+draw|Draw|Main\s+draw|Finals?)\s*==\s*$/im
  const endRe = /^==[^=].*?==\s*$/m
  const mStart = startRe.exec(text)
  if (!mStart) return text
  const rest = text.slice(mStart.index + mStart[0].length)
  const mEnd = endRe.exec(rest)
  return mEnd ? text.slice(mStart.index, mStart.index + mStart[0].length + mEnd.index) : text.slice(mStart.index)
}

function extractSeedsList(wikitext: string): DrawEntry[] {
  const startRe = /^==\s*Seeds\s*==\s*$/im
  const endRe = /^==[^=].*?==\s*$/m
  const mStart = startRe.exec(wikitext)
  if (!mStart) return []
  const rest = wikitext.slice(mStart.index + mStart[0].length)
  const mEnd = endRe.exec(rest)
  const section = mEnd ? rest.slice(0, mEnd.index) : rest

  const out: DrawEntry[] = []
  let hashIdx = 0
  let sawTemplate = false
  for (const rawLine of section.split('\n')) {
    const s = rawLine.trim()
    const tplMatch = SEEDS_TPL_RE.exec(s)
    if (tplMatch) {
      sawTemplate = true
      const seed = parseInt(tplMatch[1], 10)
      const remainder = (s.slice(0, tplMatch.index) + s.slice(tplMatch.index + tplMatch[0].length)).trim()
      const { name, country } = parsePlayer(remainder)
      if (name) out.push({ name, seed, country })
      continue
    }
    if (!sawTemplate && s.startsWith('#') && !s.startsWith('#*')) {
      const s2 = s.replace(/^#+/, '').trim()
      if (!s2) continue
      hashIdx++
      const { name, country } = parsePlayer(s2)
      if (name) out.push({ name, seed: hashIdx, country })
    }
  }
  return out
}

function extractFromBrackets(wikitext: string, alreadyKeyed: Set<string>): DrawEntry[] {
  const out: DrawEntry[] = []
  const seen = new Set<string>(alreadyKeyed)
  const scoped = scopeToMainDraw(wikitext)
  const bracketRe = /\d+TeamBracket/i
  const blocks = findTemplateBlocks(scoped, bracketRe)
  const paramRe = /\|\s*(RD\d+-(?:seed|team)\d+)\s*=\s*([^|\n]+(?:\n(?!\|)[^|\n]*)*)/gm

  for (const [a, b] of blocks) {
    const block = scoped.slice(a, b)
    const masked = maskInnerPipes(block)
    const raw = new Map<string, string>()
    let m: RegExpExecArray | null
    paramRe.lastIndex = 0
    while ((m = paramRe.exec(masked))) {
      raw.set(m[1].trim(), m[2].trim().replace(/\x00/g, '|'))
    }
    for (const [key, val] of raw) {
      const km = /(RD\d+)-team(\d+)/.exec(key)
      if (!km) continue
      const seedVal = (raw.get(`${km[1]}-seed${km[2]}`) ?? '').trim()
      const seed = /^\d+$/.test(seedVal) ? parseInt(seedVal, 10) : null
      const { name, country } = parsePlayer(val)
      if (!name) continue
      const ln = name.toLowerCase()
      if (ln === 'bye' || ln === 'tba' || ln === 'tbd' || ln === '?') continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, seed, country })
    }
  }
  return out
}

// ----- Results scraping (round_reached + points_earned) -----

import scoringPoints from '@/data/scoring_points.json'

function labelToRoundCode(label: string, drawSize: number): string {
  const norm = label.toLowerCase().trim()
  // Unambiguous labels first.
  if (/^quarter[\s-]?finals?$/.test(norm)) return 'QF'
  if (/^semi[\s-]?finals?$/.test(norm)) return 'SF'
  if (/^final$/.test(norm)) return 'F'
  const roundOf = norm.match(/^round of (\d+)$/)
  if (roundOf) return `R${roundOf[1]}`

  // Ordinal labels depend on draw size.
  const ordinalMap: Record<string, number> = {
    'first round': 1, 'second round': 2, 'third round': 3,
    'fourth round': 4, 'fifth round': 5,
  }
  if (ordinalMap[norm]) {
    if (!drawSize || drawSize < 2) return ''
    const ord = ordinalMap[norm]
    const code = drawSize / Math.pow(2, ord - 1)
    if (code >= 8) return `R${Math.round(code)}`
    if (code === 4) return 'QF'
    if (code === 2) return 'SF'
    if (code === 1) return 'F'
  }
  return ''
}

const BOLD_NAME_RE = /'''(.+?)'''/

function isBolded(team: string): boolean {
  return BOLD_NAME_RE.test(team)
}

function extractResultsFromBrackets(
  wikitext: string,
  drawSize: number,
  alreadySeeded: Map<string, DrawEntry>,
): Map<string, { name: string; country: string | null; seed: number | null; rounds_won: string[]; rounds_appeared: string[]; rounds_lost: string[] }> {
  const out = new Map<
    string,
    { name: string; country: string | null; seed: number | null; rounds_won: string[]; rounds_appeared: string[]; rounds_lost: string[] }
  >()
  // Pre-seed entries from the seeds list so we keep seed/country.
  for (const [name, e] of alreadySeeded) {
    out.set(name, {
      name,
      country: e.country,
      seed: e.seed,
      rounds_won: [],
      rounds_appeared: [],
      rounds_lost: [],
    })
  }

  const scoped = scopeToMainDraw(wikitext)
  const bracketRe = /\d+TeamBracket/i
  const blocks = findTemplateBlocks(scoped, bracketRe)
  const paramRe = /\|\s*(RD\d+(?:-(?:seed|team)\d+)?)\s*=\s*([^|\n]+(?:\n(?!\|)[^|\n]*)*)/gm

  for (const [a, b] of blocks) {
    const block = scoped.slice(a, b)
    const masked = maskInnerPipes(block)
    // RDn= label, plus RDn-teamMM= value, plus RDn-seedMM= value
    const labels = new Map<string, string>()
    const teams = new Map<string, { val: string; bold: boolean }>()
    const seeds = new Map<string, string>()
    paramRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = paramRe.exec(masked))) {
      const key = m[1].trim()
      const valRaw = m[2].trim().replace(/\x00/g, '|')
      const labelOnly = /^RD\d+$/.exec(key)
      if (labelOnly) {
        labels.set(labelOnly[0], valRaw.trim())
        continue
      }
      const seedKey = /^(RD\d+)-seed(\d+)$/.exec(key)
      if (seedKey) {
        seeds.set(`${seedKey[1]}|${seedKey[2]}`, valRaw.trim())
        continue
      }
      const teamKey = /^(RD\d+)-team(\d+)$/.exec(key)
      if (teamKey) {
        teams.set(`${teamKey[1]}|${teamKey[2]}`, { val: valRaw, bold: isBolded(valRaw) })
      }
    }

    for (const [k, t] of teams) {
      const [rdKey, _idx] = k.split('|')
      const label = labels.get(rdKey) ?? ''
      const round = labelToRoundCode(label, drawSize)
      if (!round) continue
      const { name, country } = parsePlayer(t.val)
      if (!name) continue
      const lname = name.toLowerCase()
      if (lname === 'bye' || lname === 'tba' || lname === 'tbd' || lname === '?') continue
      const seedRaw = seeds.get(k) ?? ''
      const seed = /^\d+$/.test(seedRaw) ? parseInt(seedRaw, 10) : null

      let entry = out.get(name)
      if (!entry) {
        entry = { name, country, seed, rounds_won: [], rounds_appeared: [], rounds_lost: [] }
        out.set(name, entry)
      } else {
        if (!entry.country && country) entry.country = country
        if (entry.seed == null && seed != null) entry.seed = seed
      }
      entry.rounds_appeared.push(round)
      if (t.bold) entry.rounds_won.push(round)
      else entry.rounds_lost.push(round)
    }
  }

  return out
}

function highestRound(rounds: string[]): string | null {
  let best: string | null = null
  for (const r of rounds) {
    if (!ROUND_RANK[r]) continue
    if (best === null || ROUND_RANK[r] > ROUND_RANK[best]) best = r
  }
  return best
}

function lookupPoints(tour: Tour, category: string, reached: string): number {
  if (!reached) return 0
  const points = scoringPoints as unknown as Record<string, Record<string, Record<string, number>>>
  return points[tour]?.[category]?.[reached] ?? 0
}

function effectiveDrawSize(category: string): number {
  // Matches the rounds present in data/scoring_points.json. Wikipedia uses
  // "First round" / "Second round" etc. ordinal labels; we map those to round
  // codes (R64, R32, ...) via this canonical size, so 56-draw and 96-draw
  // events resolve correctly to the same scoring rounds as 64-draw.
  switch (category) {
    case 'Slam':
      return 128
    case '1000':
      return 64
    case '500':
      return 32
    case '250':
      return 32
    case 'Finals':
      return 8
    default:
      return 32
  }
}

export async function scrapeWikiResults(
  year: number,
  name: string,
  tour: Tour,
  category: string,
  _drawSize: number = 0,
): Promise<{ title: string | null; entries: ResultEntry[] }> {
  const title = await findArticle(year, name, tour)
  if (!title) return { title: null, entries: [] }
  const wikitext = await wikiParse(title)
  if (!wikitext) return { title, entries: [] }
  const drawSize = effectiveDrawSize(category)

  // Pre-seed from ==Seeds== so we keep seed numbers even for players who
  // haven't played any bracket match yet.
  const seedsList = extractSeedsList(wikitext)
  const seededMap = new Map<string, DrawEntry>()
  for (const s of seedsList) seededMap.set(s.name, s)

  const players = extractResultsFromBrackets(wikitext, drawSize, seededMap)
  const out: ResultEntry[] = []
  for (const p of players.values()) {
    const wonF = p.rounds_won.includes('F')
    let reached: string | null = null
    if (wonF) reached = 'W'
    else {
      const maxWon = highestRound(p.rounds_won)
      if (maxWon) reached = NEXT_ROUND[maxWon] ?? maxWon
      else reached = highestRound(p.rounds_appeared)
    }
    out.push({
      name: p.name,
      country: p.country,
      seed: p.seed,
      round_reached: reached ?? '',
      points_earned: reached ? lookupPoints(tour, category, reached) : 0,
    })
  }
  return { title, entries: out }
}

export async function scrapeWikiDraw(
  year: number,
  name: string,
  tour: 'ATP' | 'WTA',
): Promise<{ title: string | null; entries: DrawEntry[] }> {
  const title = await findArticle(year, name, tour)
  if (!title) return { title: null, entries: [] }
  const wikitext = await wikiParse(title)
  if (!wikitext) return { title, entries: [] }
  const seeds = extractSeedsList(wikitext)
  const seedNames = new Set(seeds.map((s) => s.name))
  const fromBrackets = extractFromBrackets(wikitext, seedNames)
  // Merge: prefer Seeds-list seed numbers; backfill country from bracket if missing.
  const byName = new Map<string, DrawEntry>()
  for (const e of seeds) byName.set(e.name, { ...e })
  for (const e of fromBrackets) {
    const existing = byName.get(e.name)
    if (!existing) {
      byName.set(e.name, { ...e })
    } else {
      if (existing.seed == null && e.seed != null) existing.seed = e.seed
      if (!existing.country && e.country) existing.country = e.country
    }
  }
  return { title, entries: Array.from(byName.values()) }
}
