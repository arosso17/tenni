import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function LeagueDashboard({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: league } = await supabase
    .from('leagues')
    .select('id, name, slug, season_year')
    .eq('slug', slug)
    .maybeSingle()
  if (!league) notFound()

  const { data: membership } = await supabase
    .from('league_members')
    .select('role')
    .eq('league_id', league.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) notFound()

  const { data: members } = await supabase
    .from('league_members')
    .select('role, profiles(display_name)')
    .eq('league_id', league.id)

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{league.name}</h1>
          <p className="text-sm text-neutral-500">{league.season_year} season</p>
        </div>
        {membership.role === 'admin' && (
          <Link
            href={`/leagues/${league.slug}/admin`}
            className="text-sm underline"
          >
            Admin
          </Link>
        )}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Members</h2>
        <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          {(members ?? []).map((m, i) => {
            const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
            return (
              <li key={i} className="py-2 flex items-center justify-between text-sm">
                <span>{profile?.display_name ?? 'Unknown'}</span>
                <span className="text-xs uppercase tracking-wide text-neutral-500">{m.role}</span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Year-long
        </h2>
        <div className="mt-3 grid sm:grid-cols-2 gap-3">
          {(['ATP', 'WTA'] as const).map((tour) => (
            <Link
              key={tour}
              href={`/leagues/${league.slug}/year-long/${tour.toLowerCase()}`}
              className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4 hover:border-black dark:hover:border-white transition-colors"
            >
              <div className="font-medium">{tour} season</div>
              <div className="text-xs text-neutral-500 mt-1">Roster + standings + draft</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Tournaments
        </h2>
        <Link
          href={`/leagues/${league.slug}/tournaments`}
          className="mt-3 block rounded-md border border-neutral-200 dark:border-neutral-800 p-4 hover:border-black dark:hover:border-white transition-colors"
        >
          <div className="font-medium">Per-event drafts</div>
          <div className="text-xs text-neutral-500 mt-1">Calendar + picks + live scoring</div>
        </Link>
      </section>
    </main>
  )
}
