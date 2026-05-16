import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function requireUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')
  return { supabase, user }
}

export async function requireLeagueAdmin(slug: string) {
  const { supabase, user } = await requireUser()
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
  if (!membership || membership.role !== 'admin') notFound()
  return { supabase, user, league }
}

export async function requireLeagueMember(slug: string) {
  const { supabase, user } = await requireUser()
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
  return { supabase, user, league, role: membership.role as 'admin' | 'member' }
}
