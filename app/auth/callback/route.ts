import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/leagues'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }
  return NextResponse.redirect(`${origin}/auth/error`)
}
