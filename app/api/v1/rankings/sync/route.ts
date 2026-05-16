import { NextResponse } from 'next/server'
import { MatchStatProvider } from '@/lib/providers/matchstat'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET /api/v1/rankings/sync?tour=ATP|WTA
// Triggered by cron (Vercel/pg_cron) or manually by an admin.
// Updates players.current_rank + current_season_points.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const tour = url.searchParams.get('tour')
  if (tour !== 'ATP' && tour !== 'WTA') {
    return NextResponse.json({ error: 'tour must be ATP or WTA' }, { status: 400 })
  }

  // Auth: require either CRON_SECRET header or admin user. Loose for now.
  const cronSecret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret') ?? url.searchParams.get('secret')
  if (cronSecret && provided !== cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const provider = new MatchStatProvider()
    const rows = await provider.getRankings(tour)
    const admin = createAdminClient()

    let upserted = 0
    for (const r of rows) {
      const existing = await admin
        .from('players')
        .select('id')
        .eq('full_name', r.fullName)
        .eq('tour', tour)
        .maybeSingle()

      if (existing.data) {
        await admin
          .from('players')
          .update({
            external_id: r.playerExternalId,
            current_rank: r.rank,
            current_season_points: r.points,
          })
          .eq('id', existing.data.id)
      } else {
        await admin.from('players').insert({
          external_id: r.playerExternalId,
          full_name: r.fullName,
          tour,
          current_rank: r.rank,
          current_season_points: r.points,
        })
      }
      upserted++
    }

    return NextResponse.json({ tour, upserted })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
