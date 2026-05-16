import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import SignInButton from './SignInButton'
import SignOutButton from './SignOutButton'

export default async function Header() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <nav className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="font-semibold tracking-tight">tenni</Link>
        <div className="flex items-center gap-4 text-sm">
          {user ? (
            <>
              <Link href="/leagues" className="hover:underline">Leagues</Link>
              <span className="text-neutral-500 hidden sm:inline">{user.email}</span>
              <SignOutButton />
            </>
          ) : (
            <SignInButton />
          )}
        </div>
      </nav>
    </header>
  )
}
