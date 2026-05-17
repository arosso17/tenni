// Wikipedia per-event draw scraper. TS port of scripts/load_wiki_draws.py.
// Fetches the singles draw article, extracts seeded entries from the Seeds
// section (handles both `#` lists and `{{seeds|N|...}}` templates), and pulls
// remaining entries from `{{NNTeamBracket}}` templates under ==Draw==.

const WIKI_API = 'https://en.wikipedia.org/w/api.php'
const UA = 'TenniFantasy/0.1 (alrevs13@gmail.com)'

export type DrawEntry = { name: string; seed: number | null; country: string | null }

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
  for (const q of queries) {
    const titles = await wikiSearch(q)
    for (const title of titles) {
      if (seen.has(title)) continue
      seen.add(title)
      const low = title.toLowerCase()
      if (!low.includes('singles')) continue
      if (!title.includes(String(year))) continue
      if (low.includes('doubles') || low.includes('qualifying')) continue
      if (tour === 'ATP' && (low.includes('men') || low.includes('gentlemen'))) return title
      if (tour === 'WTA' && (low.includes('women') || low.includes('ladies'))) return title
    }
  }
  return null
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
