'use client'

import { createClient } from '@/lib/supabase/client'

export default function SignInButton({ next = '/leagues' }: { next?: string }) {
  const onClick = async () => {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    })
  }

  return (
    <button
      onClick={onClick}
      className="rounded-md bg-black text-white px-3 py-1.5 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
    >
      Sign in with Google
    </button>
  )
}
