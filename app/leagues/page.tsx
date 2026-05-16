import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

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
