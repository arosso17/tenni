'use client'

import { useTransition } from 'react'

export default function RoleSelect({
  slug,
  userId,
  defaultRole,
  action,
}: {
  slug: string
  userId: string
  defaultRole: string
  action: (formData: FormData) => Promise<void>
}) {
  const [pending, start] = useTransition()
  return (
    <select
      defaultValue={defaultRole}
      disabled={pending}
      onChange={(e) => {
        const fd = new FormData()
        fd.set('slug', slug)
        fd.set('user_id', userId)
        fd.set('role', e.currentTarget.value)
        start(() => action(fd))
      }}
      className="rounded border border-neutral-300 dark:border-neutral-700 bg-transparent text-xs px-2 py-1"
    >
      <option value="member">member</option>
      <option value="admin">admin</option>
    </select>
  )
}
