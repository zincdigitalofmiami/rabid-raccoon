const MS_PER_DAY = 24 * 60 * 60 * 1000

export type FeatureFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly'

export const INTRADAY_DAILY_LAG_DAYS = 1

export function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function shiftUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
}

export function conservativeLagDaysForFrequency(frequency: FeatureFrequency): number {
  switch (frequency) {
    case 'daily':
      return 1
    case 'weekly':
      return 8
    case 'monthly':
      return 35
    case 'quarterly':
      return 100
    default: {
      const never: never = frequency
      throw new Error(`Unhandled frequency: ${String(never)}`)
    }
  }
}

function rightmostIndexAtOrBefore(sortedKeys: readonly string[], targetKey: string): number {
  let lo = 0
  let hi = sortedKeys.length - 1
  let best = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const key = sortedKeys[mid]
    if (key <= targetKey) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best
}

export function asofLookupByDateKey(
  lookup: ReadonlyMap<string, number>,
  sortedKeys: readonly string[],
  targetKey: string
): number | null {
  if (sortedKeys.length === 0) return null
  const idx = rightmostIndexAtOrBefore(sortedKeys, targetKey)
  if (idx < 0) return null
  return lookup.get(sortedKeys[idx]) ?? null
}

export function asofLookupLagged(
  lookup: ReadonlyMap<string, number>,
  sortedKeys: readonly string[],
  ts: Date,
  lagDays: number
): number | null {
  const targetKey = dateKeyUtc(shiftUtcDays(ts, -lagDays))
  return asofLookupByDateKey(lookup, sortedKeys, targetKey)
}

export function laggedWindowKeys(
  ts: Date,
  lagDays: number,
  lookbackDaysInclusive: number
): { startKey: string; endKey: string } {
  const end = shiftUtcDays(ts, -lagDays)
  const start = shiftUtcDays(end, -lookbackDaysInclusive)
  return {
    startKey: dateKeyUtc(start),
    endKey: dateKeyUtc(end),
  }
}
