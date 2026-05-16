import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { slugify } from '@/lib/slug'

export const dynamic = 'force-dynamic'

async function createLeague(formData: FormData) {
  'use server'
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const name = String(formData.get('name') ?? '').trim()
  const seasonYear = Number(formData.get('season_year') ?? new Date().getFullYear())
  if (!name) throw new Error('Name required')

  const admin = createAdminClient()

  // Ensure profile exists (safety net for users who signed up before the trigger existed).
  await admin.from('profiles').upsert(
    {
      id: user.id,
      display_name:
        (user.user_metadata?.full_name as string | undefined) ??
        (user.user_metadata?.name as string | undefined) ??
        user.email ??
        'Player',
      avatar_url: (user.user_metadata?.avatar_url as string | undefined) ?? null,
    },
    { onConflict: 'id' }
  )

  const baseSlug = slugify(name)
  let slug = baseSlug
  let attempt = 0
  while (attempt < 5) {
    const { data: existing } = await admin
      .from('leagues')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()
    if (!existing) break
    attempt++
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`
  }

  const { data: league, error } = await admin
    .from('leagues')
    .insert({
      name,
      slug,
      creator_id: user.id,
      season_year: seasonYear,
      season_start: `${seasonYear}-01-01`,
      season_end: `${seasonYear}-12-31`,
    })
    .select('id, slug')
    .single()
  if (error || !league) throw new Error(error?.message ?? 'Create failed')

  await admin.from('league_members').insert({
    league_id: league.id,
    user_id: user.id,
    role: 'admin',
  })

  redirect(`/leagues/${league.slug}`)
}

export default async function NewLeaguePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  return (
    <main className="max-w-md mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold">New league</h1>
      <form action={createLeague} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">League name</label>
          <input
            name="name"
            required
            maxLength={80}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
            placeholder="The Big Three"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Season year</label>
          <input
            name="season_year"
            type="number"
            defaultValue={new Date().getFullYear()}
            min={2024}
            max={2100}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-black text-white py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
        >
          Create
        </button>
      </form>
    </main>
  )
}
