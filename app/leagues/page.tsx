import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export default async function LeaguesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: memberships } = await supabase
    .from('league_members')
    .select('role, leagues(id, name, slug, season_year)')
    .eq('user_id', user.id)

  const rows = (memberships ?? [])
    .map((m) => ({ role: m.role, league: Array.isArray(m.leagues) ? m.leagues[0] : m.leagues }))
    .filter((r) => r.league)

  const memberLeagueIds = new Set(rows.map((r) => r.league.id))

  let pending: Array<{ token: string; league_name: string; league_slug: string }> = []
  if (user.email) {
    const admin = createAdminClient()
    const { data: invites } = await admin
      .from('invites')
      .select('token, league_id, email, accepted_at, expires_at, leagues(name, slug)')
      .ilike('email', user.email)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())

    pending = (invites ?? [])
      .filter((inv) => !memberLeagueIds.has(inv.league_id))
      .map((inv) => {
        const lg = Array.isArray(inv.leagues) ? inv.leagues[0] : inv.leagues
        return { token: inv.token, league_name: lg?.name ?? 'league', league_slug: lg?.slug ?? '' }
      })
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your leagues</h1>
        <Link
          href="/leagues/new"
          className="rounded-md bg-black text-white px-3 py-1.5 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
        >
          New league
        </Link>
      </div>

      {pending.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
            Pending invites
          </h2>
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {pending.map((inv) => (
              <li key={inv.token} className="py-3 flex items-center justify-between">
                <span className="font-medium">{inv.league_name}</span>
                <Link
                  href={`/join/${inv.token}`}
                  className="rounded-md bg-black text-white px-3 py-1.5 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
                >
                  Accept
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows.length === 0 ? (
        <p className="mt-8 text-neutral-500">
          You&apos;re not in any leagues yet. Create one or accept an invite.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map(({ role, league }) => (
            <li key={league.id} className="py-3 flex items-center justify-between">
              <div>
                <Link href={`/leagues/${league.slug}`} className="font-medium hover:underline">
                  {league.name}
                </Link>
                <span className="ml-2 text-xs text-neutral-500">{league.season_year}</span>
              </div>
              <span className="text-xs uppercase tracking-wide text-neutral-500">{role}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
