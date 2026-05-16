import { notFound, redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { headers } from 'next/headers'
import RoleSelect from '@/components/RoleSelect'

export const dynamic = 'force-dynamic'

async function requireAdmin(slug: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: league } = await supabase
    .from('leagues')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()
  if (!league) notFound()

  const { data: membership } = await supabase
    .from('league_members')
    .select('role')
    .eq('league_id', league.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership || membership.role !== 'admin') notFound()

  return { user, league }
}

async function createInvite(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const email = String(formData.get('email') ?? '').trim() || null
  const { user, league } = await requireAdmin(slug)
  const admin = createAdminClient()
  await admin.from('invites').insert({
    league_id: league.id,
    email,
    invited_by: user.id,
  })
  revalidatePath(`/leagues/${slug}/admin`)
}

async function setRole(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const userId = String(formData.get('user_id'))
  const role = String(formData.get('role'))
  if (!['admin', 'member'].includes(role)) return
  const { league } = await requireAdmin(slug)
  const admin = createAdminClient()
  await admin
    .from('league_members')
    .update({ role })
    .eq('league_id', league.id)
    .eq('user_id', userId)
  revalidatePath(`/leagues/${slug}/admin`)
}

async function removeMember(formData: FormData) {
  'use server'
  const slug = String(formData.get('slug'))
  const userId = String(formData.get('user_id'))
  const { league } = await requireAdmin(slug)
  const admin = createAdminClient()
  await admin
    .from('league_members')
    .delete()
    .eq('league_id', league.id)
    .eq('user_id', userId)
  revalidatePath(`/leagues/${slug}/admin`)
}

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const { league } = await requireAdmin(slug)
  const admin = createAdminClient()

  const [{ data: members }, { data: invites }] = await Promise.all([
    admin
      .from('league_members')
      .select('user_id, role, profiles(display_name)')
      .eq('league_id', league.id),
    admin
      .from('invites')
      .select('id, email, token, accepted_at, expires_at, created_at:expires_at')
      .eq('league_id', league.id)
      .is('accepted_at', null)
      .order('expires_at', { ascending: false }),
  ])

  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'http'
  const host = h.get('host') ?? 'localhost:3000'
  const origin = `${proto}://${host}`

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{league.name} — Admin</h1>
        <a
          href={`/leagues/${slug}/admin/tournaments`}
          className="text-sm underline"
        >
          Manage tournaments →
        </a>
      </div>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Members</h2>
        <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          {(members ?? []).map((m) => {
            const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
            return (
              <li key={m.user_id} className="py-3 flex items-center justify-between text-sm">
                <span>{profile?.display_name ?? m.user_id.slice(0, 8)}</span>
                <div className="flex items-center gap-2">
                  <RoleSelect
                    slug={slug}
                    userId={m.user_id}
                    defaultRole={m.role}
                    action={setRole}
                  />
                  <form action={removeMember}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="user_id" value={m.user_id} />
                    <button
                      type="submit"
                      className="text-xs text-red-500 hover:underline"
                    >
                      remove
                    </button>
                  </form>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Invite</h2>
        <form action={createInvite} className="mt-3 flex gap-2">
          <input type="hidden" name="slug" value={slug} />
          <input
            name="email"
            type="email"
            placeholder="email (optional)"
            className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-black text-white px-3 py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
          >
            Generate invite
          </button>
        </form>

        <ul className="mt-4 space-y-2 text-sm">
          {(invites ?? []).map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3">
              <code className="text-xs text-neutral-500 break-all">
                {origin}/join/{inv.token}
              </code>
              <span className="text-xs text-neutral-500 whitespace-nowrap">
                {inv.email ?? 'any'}
              </span>
            </li>
          ))}
          {(!invites || invites.length === 0) && (
            <li className="text-neutral-500">No active invites.</li>
          )}
        </ul>
      </section>
    </main>
  )
}
