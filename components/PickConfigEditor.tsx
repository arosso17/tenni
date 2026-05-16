'use client'

import { useTransition, useState } from 'react'

type Cfg = { top8: number; '9-16': number; unseeded: number }

export default function PickConfigEditor({
  slug,
  tournamentId,
  initial,
  action,
}: {
  slug: string
  tournamentId: string
  initial: Cfg
  action: (formData: FormData) => Promise<void>
}) {
  const [cfg, setCfg] = useState<Cfg>(initial)
  const [pending, start] = useTransition()
  const dirty =
    cfg.top8 !== initial.top8 ||
    cfg['9-16'] !== initial['9-16'] ||
    cfg.unseeded !== initial.unseeded

  const save = () => {
    const fd = new FormData()
    fd.set('slug', slug)
    fd.set('tournament_id', tournamentId)
    fd.set('top8', String(cfg.top8))
    fd.set('9-16', String(cfg['9-16']))
    fd.set('unseeded', String(cfg.unseeded))
    start(() => action(fd))
  }

  const Field = ({ k, label }: { k: keyof Cfg; label: string }) => (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-neutral-500">{label}</span>
      <input
        type="number"
        min={0}
        max={20}
        value={cfg[k]}
        onChange={(e) =>
          setCfg({ ...cfg, [k]: Math.max(0, Number(e.target.value || 0)) })
        }
        className="w-12 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-1 py-0.5"
      />
    </label>
  )

  return (
    <div className="mt-2 flex items-center gap-3">
      <Field k="top8" label="top 8" />
      <Field k="9-16" label="9–16" />
      <Field k="unseeded" label="unseeded" />
      {dirty && (
        <button
          onClick={save}
          disabled={pending}
          className="text-xs underline disabled:opacity-50"
        >
          save
        </button>
      )}
    </div>
  )
}
