import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireLeagueAdmin } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { scrapeWikiDraw } from '@/lib/wikiDraws'

export const dynamic = 'force-dynamic'

type DrawEntry = {
  name: string
  seed?: number | null
  country?: string | null
  status?: string | null
  points_earned?: number | null
}

async function loadDraw(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tid = String(formData.get('tid'))
  const raw = String(formData.get('draw') ?? '').trim()
  const mode = String(formData.get('mode') ?? 'replace') // replace | merge

  await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const { data: t } = await admin
    .from('tournaments')
    .select('id, tour')
    .eq('id', tid)
    .maybeSingle()
  if (!t) throw new Error('tournament not found')

  let entries: DrawEntry[]
  try {
    entries = parseDraw(raw)
  } catch (e) {
    throw new Error('parse error: ' + (e instanceof Error ? e.message : 'unknown'))
  }
  if (entries.length === 0) throw new Error('no entries parsed')

  if (mode === 'replace') {
    await admin.from('player_tournaments').delete().eq('tournament_id', tid)
  }

  for (const e of entries) {
    const fullName = e.name.trim()
    if (!fullName) continue

    let { data: existing } = await admin
      .from('players')
      .select('id')
      .eq('full_name', fullName)
      .eq('tour', t.tour)
      .maybeSingle()

    if (!existing) {
      const ins = await admin
        .from('players')
        .insert({
          full_name: fullName,
          tour: t.tour,
          country: e.country ?? null,
        })
        .select('id')
        .single()
      existing = ins.data
    } else if (e.country) {
      await admin.from('players').update({ country: e.country }).eq('id', existing.id)
    }
    if (!existing) continue

    await admin.from('player_tournaments').upsert({
      tournament_id: tid,
      player_id: existing.id,
      seed: e.seed ?? null,
      status: e.status ?? 'entered',
      points_earned: e.points_earned ?? 0,
    })
  }

  revalidatePath(`/leagues/${slug}/tournaments/${tid}`)
  revalidatePath(`/leagues/${slug}/tournaments/${tid}/admin`)
  redirect(`/leagues/${slug}/tournaments/${tid}/admin?ok=${entries.length}`)
}

async function loadFromWiki(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const tid = String(formData.get('tid'))
  const mode = String(formData.get('mode') ?? 'merge')
  await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const { data: t } = await admin
    .from('tournaments')
    .select('id, name, tour, start_date')
    .eq('id', tid)
    .maybeSingle()
  if (!t) throw new Error('tournament not found')

  const year = parseInt((t.start_date ?? '').slice(0, 4), 10)
  const { title, entries } = await scrapeWikiDraw(year, t.name, t.tour as 'ATP' | 'WTA')
  if (!title || entries.length === 0) {
    redirect(`/leagues/${slug}/tournaments/${tid}/admin?wiki=miss`)
  }

  if (mode === 'replace') {
    await admin.from('player_tournaments').delete().eq('tournament_id', tid)
  }

  for (const e of entries) {
    if (!e.name) continue
    let { data: existing } = await admin
      .from('players')
      .select('id')
      .eq('full_name', e.name)
      .eq('tour', t.tour)
      .maybeSingle()
    if (!existing) {
      const ins = await admin
        .from('players')
        .insert({ full_name: e.name, tour: t.tour, country: e.country })
        .select('id')
        .single()
      existing = ins.data
    } else if (e.country) {
      await admin.from('players').update({ country: e.country }).eq('id', existing.id)
    }
    if (!existing) continue
    await admin.from('player_tournaments').upsert({
      tournament_id: tid,
      player_id: existing.id,
      seed: e.seed,
      status: 'entered',
    })
  }

  revalidatePath(`/leagues/${slug}/tournaments/${tid}`)
  revalidatePath(`/leagues/${slug}/tournaments/${tid}/admin`)
  redirect(
    `/leagues/${slug}/tournaments/${tid}/admin?wiki=${entries.length}&title=${encodeURIComponent(title)}`,
  )
}

function parseDraw(raw: string): DrawEntry[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((p) => ({
      name: String(p.name ?? p.full_name ?? '').trim(),
      seed: p.seed == null ? null : Number(p.seed),
      country: p.country ?? null,
      status: p.status ?? null,
      points_earned: p.points_earned == null ? 0 : Number(p.points_earned),
    }))
  }
  // CSV / line format: "name, seed, country" — seed + country optional
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((s) => s.trim())
      const name = parts[0]
      const seedRaw = parts[1]
      const country = parts[2] || null
      const seed = seedRaw && /^\d+$/.test(seedRaw) ? Number(seedRaw) : null
      return { name, seed, country }
    })
    .filter((e) => e.name)
}

export default async function TournamentAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; tid: string }>
  searchParams: Promise<{ ok?: string; wiki?: string; title?: string }>
}) {
  const { slug, tid } = await params
  const { ok, wiki, title: wikiTitle } = await searchParams
  const { league } = await requireLeagueAdmin(slug)
  const admin = createAdminClient()

  const [{ data: tournament }, { data: draw }] = await Promise.all([
    admin
      .from('tournaments')
      .select('name, tour, category, start_date')
      .eq('id', tid)
      .maybeSingle(),
    admin
      .from('draw_with_tier')
      .select('player_id, full_name, country, seed, tier')
      .eq('tournament_id', tid)
      .order('seed', { ascending: true, nullsFirst: false }),
  ])
  if (!tournament) notFound()

  return (
    <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <Link
          href={`/leagues/${slug}/tournaments/${tid}`}
          className="text-sm text-neutral-500 hover:underline"
        >
          ← {tournament.name}
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Manage draw</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {tournament.tour} {tournament.category} · {tournament.start_date} · {league.name}
        </p>
      </div>

      {ok && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Loaded {ok} entries.
        </div>
      )}
      {wiki === 'miss' && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          No Wikipedia article found yet. Wikipedia typically publishes draws ~1 week before the event.
        </div>
      )}
      {wiki && wiki !== 'miss' && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          Loaded {wiki} entries from Wikipedia
          {wikiTitle && (
            <>
              {' '}
              (<span className="font-medium">{wikiTitle}</span>)
            </>
          )}
          .
        </div>
      )}

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Load from Wikipedia
        </h2>
        <p className="mt-2 text-xs text-neutral-500">
          Scrapes the singles-draw article (and Draft: namespace) for seeds + entrants.
          Re-run as Wikipedia fills in the bracket.
        </p>
        <form action={loadFromWiki} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="tid" value={tid} />
          <label className="text-sm flex items-center gap-1.5">
            <input type="radio" name="mode" value="merge" defaultChecked />
            Merge
          </label>
          <label className="text-sm flex items-center gap-1.5">
            <input type="radio" name="mode" value="replace" />
            Replace
          </label>
          <button
            type="submit"
            className="ml-auto rounded-md bg-black text-white px-4 py-2 text-sm dark:bg-white dark:text-black"
          >
            Pull from Wikipedia
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Load entries manually
        </h2>
        <form action={loadDraw} className="mt-3 space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="tid" value={tid} />
          <p className="text-xs text-neutral-500">
            One per line: <code>Name, seed, country</code> (seed + country optional). Or paste JSON{' '}
            <code>{`[{"name":"...","seed":1,"country":"ESP"}]`}</code>. Country uses IOC 3-letter code.
          </p>
          <textarea
            name="draw"
            required
            rows={14}
            placeholder={'Carlos Alcaraz, 1, ESP\nJannik Sinner, 2, ITA\nNovak Djokovic, 3, SRB\nDenis Shapovalov, , CAN'}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-xs font-mono"
          />
          <div className="flex items-center gap-3">
            <label className="text-sm flex items-center gap-1.5">
              <input type="radio" name="mode" value="replace" defaultChecked />
              Replace
            </label>
            <label className="text-sm flex items-center gap-1.5">
              <input type="radio" name="mode" value="merge" />
              Merge
            </label>
            <button
              type="submit"
              className="ml-auto rounded-md bg-black text-white px-4 py-2 text-sm dark:bg-white dark:text-black"
            >
              Load draw
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Current draw ({draw?.length ?? 0})
        </h2>
        {(!draw || draw.length === 0) ? (
          <p className="mt-3 text-sm text-neutral-500">Empty.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
            {draw.map((p) => (
              <li key={p.player_id} className="flex gap-2">
                <span className="w-8 tabular-nums text-neutral-500">
                  {p.seed != null ? `[${p.seed}]` : '—'}
                </span>
                <span className="flex-1 truncate">{p.full_name}</span>
                <span className="text-neutral-500">{p.tier}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
