/**
 * feature-utils.ts
 *
 * Shared feature engineering utilities for MES dataset builders.
 * Used by both build-complete-dataset.ts (1h) and build-15m-dataset.ts (15m).
 *
 * Data Dictionary v2.0 derived features:
 *   - Rolling percentile, correlation, std for nullable arrays
 *   - Weekly/monthly trend computations for forward-filled sparse series
 *   - Sahm Rule proxy, YoY growth, shock flags
 *   - Cross-asset futures alignment and correlation
 */

// ─── Nullable Array Rolling Helpers ───────────────────────────────────────
// These operate on arrays that may contain nulls (forward-filled FRED data)

/**
 * Rolling percentile: what fraction of non-null values in the window
 * are less than the current value. Returns 0..1 or null.
 */
export function rollingPercentile(
  arr: (number | null)[],
  idx: number,
  window: number
): number | null {
  const current = arr[idx]
  if (current == null) return null

  const start = Math.max(0, idx - window + 1)
  let below = 0
  let total = 0
  for (let j = start; j <= idx; j++) {
    if (arr[j] != null) {
      total++
      if (arr[j]! < current) below++
    }
  }
  return total > 5 ? below / total : null // require minimum 5 observations
}

/**
 * Rolling correlation between two nullable return series.
 * Pearson r over the last `window` positions where both are non-null.
 */
export function rollingCorrelation(
  arr1: (number | null)[],
  arr2: (number | null)[],
  idx: number,
  window: number
): number | null {
  const start = Math.max(0, idx - window + 1)
  const pairs: [number, number][] = []
  for (let j = start; j <= idx; j++) {
    if (arr1[j] != null && arr2[j] != null) {
      pairs.push([arr1[j]!, arr2[j]!])
    }
  }
  if (pairs.length < 10) return null // need meaningful sample

  const n = pairs.length
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
  for (const [x, y] of pairs) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
  if (denom === 0) return null
  return (n * sumXY - sumX * sumY) / denom
}

/**
 * Rolling std for nullable arrays.
 * Returns null if fewer than 5 non-null values in window.
 */
export function rollingStdNullable(
  arr: (number | null)[],
  idx: number,
  window: number
): number | null {
  const start = Math.max(0, idx - window + 1)
  const vals: number[] = []
  for (let j = start; j <= idx; j++) {
    if (arr[j] != null) vals.push(arr[j]!)
  }
  if (vals.length < 5) return null

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length
  return Math.sqrt(variance)
}

/**
 * Simple delta: current value minus value N positions back.
 * For velocity/momentum features on FRED arrays.
 */
export function deltaBack(
  arr: (number | null)[],
  idx: number,
  lookback: number
): number | null {
  if (idx < lookback) return null
  const current = arr[idx]
  const prev = arr[idx - lookback]
  if (current == null || prev == null) return null
  return current - prev
}

/**
 * Pct change delta: (current - prev) / |prev|. For momentum features.
 */
export function pctDeltaBack(
  arr: (number | null)[],
  idx: number,
  lookback: number
): number | null {
  if (idx < lookback) return null
  const current = arr[idx]
  const prev = arr[idx - lookback]
  if (current == null || prev == null || prev === 0) return null
  return (current - prev) / Math.abs(prev)
}

/**
 * Shock flag: 1 if |pctDelta| > threshold * rollingSigma, else 0.
 * Used for WTI/CL/CNY shock detection (>2σ daily move).
 */
export function shockFlag(
  arr: (number | null)[],
  idx: number,
  deltaLookback: number,
  sigmaWindow: number,
  sigmaMultiple: number = 2
): number | null {
  const delta = pctDeltaBack(arr, idx, deltaLookback)
  const sigma = rollingStdNullable(
    // compute pct returns for sigma window
    arr.map((v, j) => {
      if (j < deltaLookback || v == null || arr[j - deltaLookback] == null || arr[j - deltaLookback] === 0) return null
      return (v - arr[j - deltaLookback]!) / Math.abs(arr[j - deltaLookback]!)
    }),
    idx,
    sigmaWindow
  )
  if (delta == null || sigma == null || sigma === 0) return null
  return Math.abs(delta) > sigmaMultiple * sigma ? 1 : 0
}

/**
 * Rolling minimum for nullable arrays.
 * Used for Sahm Rule proxy (12-month low of unemployment rate).
 */
export function rollingMinNullable(
  arr: (number | null)[],
  idx: number,
  window: number
): number | null {
  const start = Math.max(0, idx - window + 1)
  let min: number | null = null
  for (let j = start; j <= idx; j++) {
    if (arr[j] != null) {
      if (min == null || arr[j]! < min) min = arr[j]!
    }
  }
  return min
}

/**
 * Build a parallel array of FRED as-of values aligned to candle timestamps.
 * This converts point-in-time lookups into an array that supports
 * velocity/momentum/percentile features via index-based lookback.
 */
export function buildFredArray(
  candles: { eventTime: Date }[],
  lookup: ReadonlyMap<string, number>,
  sortedKeys: readonly string[],
  lagDays: number,
  dateKeyFn: (d: Date) => string,
  asofFn: (lookup: ReadonlyMap<string, number>, keys: readonly string[], key: string) => number | null
): (number | null)[] {
  return candles.map(c => {
    const targetKey = dateKeyFn(new Date(c.eventTime.getTime() - lagDays * 24 * 60 * 60 * 1000))
    return asofFn(lookup, sortedKeys, targetKey)
  })
}

/**
 * Cross-asset bar alignment: given MES candle timestamps and another
 * symbol's bars, produce an aligned array of close prices.
 * Forward-fills within sessions, null for extended gaps.
 */
export function alignCrossAssetBars(
  mesTimestamps: Date[],
  bars: Map<string, number>,  // isoString → close price
  maxGapHours: number = 4
): (number | null)[] {
  const result: (number | null)[] = new Array(mesTimestamps.length).fill(null)
  let lastValue: number | null = null
  let lastTime: number = 0

  for (let i = 0; i < mesTimestamps.length; i++) {
    const ts = mesTimestamps[i]
    const key = ts.toISOString()
    const bar = bars.get(key)

    if (bar != null) {
      result[i] = bar
      lastValue = bar
      lastTime = ts.getTime()
    } else if (lastValue != null) {
      const gapMs = ts.getTime() - lastTime
      if (gapMs <= maxGapHours * 3600 * 1000) {
        result[i] = lastValue // forward-fill within gap tolerance
      } else {
        result[i] = null
        lastValue = null
      }
    }
  }
  return result
}
