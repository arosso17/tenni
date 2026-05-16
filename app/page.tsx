import { createClient } from '@/lib/supabase/server'
import SignInButton from '@/components/SignInButton'
import Link from 'next/link'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <main className="min-h-[80dvh] flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Tenni</h1>
      <p className="mt-3 text-neutral-500 max-w-md">
        Fantasy tennis for friends. ATP + WTA, year-long roster + per-tournament drafts,
        powered by real ranking points.
      </p>
      <div className="mt-8">
        {user ? (
          <Link
            href="/leagues"
            className="rounded-md bg-black text-white px-4 py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
          >
            Go to your leagues
          </Link>
        ) : (
          <SignInButton />
        )}
      </div>
    </main>
  )
}
