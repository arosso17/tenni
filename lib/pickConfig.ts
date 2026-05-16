export type PickConfig = { top8: number; '9-16': number; unseeded: number }

export function defaultPickConfig(category: string): PickConfig {
  switch (category) {
    case 'Slam':
      return { top8: 4, '9-16': 3, unseeded: 3 }
    case '1000':
      return { top8: 2, '9-16': 2, unseeded: 2 }
    case '500':
      return { top8: 3, '9-16': 0, unseeded: 1 }
    case '250':
      return { top8: 3, '9-16': 0, unseeded: 1 }
    case 'Finals':
      return { top8: 4, '9-16': 0, unseeded: 0 }
    default:
      return { top8: 2, '9-16': 1, unseeded: 1 }
  }
}

export function totalPicks(cfg: PickConfig): number {
  return cfg.top8 + cfg['9-16'] + cfg.unseeded
}
