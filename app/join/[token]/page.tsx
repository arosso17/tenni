import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

async function accept(formData: FormData) {
  'use server'
  const token = String(formData.get('token'))
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/?next=/join/${token}`)

  const admin = createAdminClient()
  const { data: invite } = await admin
    .from('invites')
    .select('id, league_id, email, accepted_at, expires_at, leagues(slug)')
    .eq('token', token)
    .maybeSingle()
  if (!invite) throw new Error('Invite not found')
  if (invite.accepted_at) throw new Error('Invite already used')
  if (new Date(invite.expires_at) < new Date()) throw new Error('Invite expired')
  if (invite.email && invite.email.toLowerCase() !== (user.email ?? '').toLowerCase()) {
    throw new Error('Invite is for a different email')
  }

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

  await admin
    .from('league_members')
    .upsert({ league_id: invite.league_id, user_id: user.id, role: 'member' })
  await admin.from('invites').update({ accepted_at: new Date().toISOString() }).eq('id', invite.id)

  const league = Array.isArray(invite.leagues) ? invite.leagues[0] : invite.leagues
  redirect(`/leagues/${league?.slug ?? ''}`)
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const admin = createAdminClient()
  const { data: invite } = await admin
    .from('invites')
    .select('league_id, email, accepted_at, expires_at, leagues(name)')
    .eq('token', token)
    .maybeSingle()

  if (!invite) {
    return (
      <main className="max-w-md mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-semibold">Invite not found</h1>
      </main>
    )
  }

  const league = Array.isArray(invite.leagues) ? invite.leagues[0] : invite.leagues
  const expired = new Date(invite.expires_at) < new Date()
  const used = !!invite.accepted_at

  return (
    <main className="max-w-md mx-auto px-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Join {league?.name ?? 'league'}</h1>
      {used && <p className="mt-3 text-neutral-500">This invite has already been accepted.</p>}
      {expired && <p className="mt-3 text-neutral-500">This invite has expired.</p>}
      {!used && !expired && (
        user ? (
          <form action={accept} className="mt-6">
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="rounded-md bg-black text-white px-4 py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
            >
              Accept invite
            </button>
          </form>
        ) : (
          <p className="mt-3 text-neutral-500">Sign in (top right) to accept.</p>
        )
      )}
    </main>
  )
}
