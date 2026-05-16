'use client'

import { useState } from 'react'

type Member = { userId: string; name: string }

export default function PickOrderEditor({
  slug,
  tour,
  members,
  action,
}: {
  slug: string
  tour: 'ATP' | 'WTA'
  members: Member[]
  action: (formData: FormData) => void | Promise<void>
}) {
  const [order, setOrder] = useState<Member[]>(members)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const move = (from: number, to: number) => {
    if (from === to) return
    const next = order.slice()
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    setOrder(next)
  }

  const randomize = () => {
    const next = order.slice()
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[next[i], next[j]] = [next[j], next[i]]
    }
    setOrder(next)
  }

  const reverse = () => setOrder(order.slice().reverse())

  return (
    <form action={action} className="mt-6 space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="tour" value={tour} />
      <input
        type="hidden"
        name="order"
        value={order.map((m) => m.userId).join(',')}
      />

      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Pick order</label>
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={randomize}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Randomize
          </button>
          <button
            type="button"
            onClick={reverse}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Reverse
          </button>
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        Drag to reorder. Snake: this order runs round 1, reverses each subsequent round.
      </p>

      <ul className="rounded-md border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-800">
        {order.map((m, i) => (
          <li
            key={m.userId}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragIdx !== null && dragIdx !== i) move(dragIdx, i)
              setDragIdx(i)
            }}
            onDragEnd={() => setDragIdx(null)}
            className={
              'flex items-center gap-3 px-3 py-2 cursor-grab active:cursor-grabbing ' +
              (dragIdx === i ? 'bg-neutral-100 dark:bg-neutral-800' : '')
            }
          >
            <span className="text-neutral-400 select-none">⋮⋮</span>
            <span className="w-6 text-xs text-neutral-500 tabular-nums">{i + 1}.</span>
            <span className="text-sm font-medium flex-1">{m.name}</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => i > 0 && move(i, i - 1)}
                disabled={i === 0}
                className="text-xs text-neutral-500 disabled:opacity-30 px-1.5"
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => i < order.length - 1 && move(i, i + 1)}
                disabled={i === order.length - 1}
                className="text-xs text-neutral-500 disabled:opacity-30 px-1.5"
                aria-label="Move down"
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="submit"
        className="w-full rounded-md bg-black text-white py-2 text-sm hover:bg-neutral-800 dark:bg-white dark:text-black"
      >
        Start draft
      </button>
    </form>
  )
}
