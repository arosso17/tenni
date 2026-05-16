import { NextResponse } from 'next/server'
import { MatchStatProvider } from '@/lib/providers/matchstat'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET /api/v1/tournaments/sync?year=2026
// Pulls ATP + WTA calendars from MatchStat, upserts tournaments by external_id.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const year = Number(url.searchParams.get('year') ?? new Date().getFullYear())
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 400 })
  }

  const cronSecret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret') ?? url.searchParams.get('secret')
  if (cronSecret && provided !== cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const provider = new MatchStatProvider()
    const tournaments = await provider.listTournaments(year)
    const admin = createAdminClient()

    let upserted = 0
    for (const t of tournaments) {
      const startStatus =
        new Date(t.endDate) < new Date()
          ? 'completed'
          : new Date(t.startDate) <= new Date()
            ? 'live'
            : 'upcoming'
      await admin.from('tournaments').upsert(
        {
          external_id: t.externalId,
          name: t.name,
          tour: t.tour,
          category: t.category,
          draw_size: t.drawSize || null,
          surface: t.surface ?? null,
          start_date: t.startDate.slice(0, 10),
          end_date: t.endDate.slice(0, 10),
          week_start: weekStart(t.startDate),
          status: startStatus,
        },
        { onConflict: 'external_id' }
      )
      upserted++
    }

    return NextResponse.json({ year, upserted })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

function weekStart(iso: string): string {
  const d = new Date(iso)
  const day = d.getUTCDay() // 0=Sun
  const offset = (day + 6) % 7 // Mon=0
  d.setUTCDate(d.getUTCDate() - offset)
  return d.toISOString().slice(0, 10)
}
