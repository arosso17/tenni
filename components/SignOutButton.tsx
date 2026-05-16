'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignOutButton() {
  const router = useRouter()
  const onClick = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }
  return (
    <button onClick={onClick} className="text-sm text-neutral-500 hover:underline">
      Sign out
    </button>
  )
}
