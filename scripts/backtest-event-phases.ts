#!/usr/bin/env npx tsx
/**
 * Backtest: BHG setup outcomes by proximity to economic events.
 *
 * Derives data-driven phase boundaries and confidence adjustments
 * for the Event Awareness Engine (src/lib/event-awareness.ts).
 *
 * Loads all bhg_setups with outcomes (tp1Hit IS NOT NULL) and all
 * high/medium-impact econ_calendar rows, then measures how TP1/TP2
 * hit rates vary by proximity to the nearest event.
 *
 * Usage: npx tsx scripts/backtest-event-phases.ts
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupRow {
  goTime: Date | null
  tp1Hit: boolean | null
  tp2Hit: boolean | null
}

interface EventRow {
  eventDate: Date
  eventTime: string | null
  impactRating: string | null
}

interface ParsedEvent {
  time: Date
}

interface BucketStats {
  label: string
  setups: number
  tp1Hits: number
  tp2Hits: number
  tp1Rate: number
  tp2Rate: number
  vsBaseline: number // percentage point difference from baseline TP1 rate
  lowConfidence: boolean
}

// ─── DST-Aware ET → UTC Parsing ──────────────────────────────────────────────
// Copied from src/lib/event-awareness.ts (parseEventTimeET pattern)

/**
 * Parse an eventTime string like "08:30 ET" into a full UTC Date
 * by combining it with the eventDate. Handles EST/EDT correctly using
 * US DST rules: DST starts second Sunday of March, ends first Sunday of November.
 *
 * Returns null for unparseable times (e.g. "After Close", "Tentative", null).
 */
function parseEventTimeET(eventDate: Date, eventTime: string | null): Date | null {
  if (!eventTime) return null

  const match = eventTime.match(/^(\d{1,2}):(\d{2})\s*ET$/i)
  if (!match) return null

  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

  const year = eventDate.getUTCFullYear()
  const month = eventDate.getUTCMonth()
  const day = eventDate.getUTCDate()

  const isDST = isEasternDST(year, month, day)
  const utcOffsetHours = isDST ? -4 : -5

  // Local ET time minus the offset → UTC
  // e.g. 08:30 ET during EDT (UTC-4) → 08:30 + 4 = 12:30 UTC
  return new Date(Date.UTC(year, month, day, hours - utcOffsetHours, minutes, 0, 0))
}

function isEasternDST(year: number, month: number, day: number): boolean {
  if (month < 2 || month > 10) return false
  if (month > 2 && month < 10) return true

  if (month === 2) {
    const secondSunday = getSecondSundayOfMarch(year)
    return day >= secondSunday
  }

  // month === 10 → November
  const firstSunday = getFirstSundayOfNovember(year)
  return day < firstSunday
}

function getSecondSundayOfMarch(year: number): number {
  const march1 = new Date(Date.UTC(year, 2, 1)).getUTCDay()
  const firstSunday = march1 === 0 ? 1 : 8 - march1
  return firstSunday + 7
}

function getFirstSundayOfNovember(year: number): number {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  return nov1 === 0 ? 1 : 8 - nov1
}

// ─── Bucket Definitions ──────────────────────────────────────────────────────

/** Proximity buckets in minutes */
const BUCKET_BOUNDS = [
  { min: 0, max: 5, label: '0-5 min' },
  { min: 5, max: 10, label: '5-10 min' },
  { min: 10, max: 15, label: '10-15 min' },
  { min: 15, max: 30, label: '15-30 min' },
  { min: 30, max: 60, label: '30-60 min' },
  { min: 60, max: 120, label: '60-120 min' },
]

const BASELINE_THRESHOLD_MIN = 120
const LOW_CONFIDENCE_THRESHOLD = 5

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(n: number, d: number): number {
  return d === 0 ? 0 : (n / d) * 100
}

function fmtPct(val: number): string {
  const sign = val >= 0 ? '+' : ''
  return `${sign}${val.toFixed(1)}%`
}

function pad(str: string, width: number): string {
  return str.padEnd(width)
}

function padLeft(str: string, width: number): string {
  return str.padStart(width)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotEnvFiles()

  console.log('[backtest-event-phases] Loading BHG setups with outcomes...')

  // Load all setups where tp1Hit has been determined (outcome known)
  const setups: SetupRow[] = await prisma.bhgSetup.findMany({
    where: {
      tp1Hit: { not: null },
    },
    select: {
      goTime: true,
      tp1Hit: true,
      tp2Hit: true,
    },
  })

  // Filter out setups with null goTime
  const validSetups = setups.filter(
    (s): s is SetupRow & { goTime: Date } => s.goTime !== null
  )

  console.log(`[backtest-event-phases] Total setups with outcomes: ${setups.length}`)
  console.log(`[backtest-event-phases] Setups with valid goTime: ${validSetups.length}`)

  if (validSetups.length === 0) {
    console.log('\nNo BHG setups with outcomes found. Run build-bhg-dataset.ts first to populate tp1Hit/tp2Hit.')
    await prisma.$disconnect()
    return
  }

  // Load high/medium impact econ events
  console.log('[backtest-event-phases] Loading high/medium impact economic events...')

  const econRows: EventRow[] = await prisma.econCalendar.findMany({
    where: {
      impactRating: { in: ['high', 'medium'] },
    },
    select: {
      eventDate: true,
      eventTime: true,
      impactRating: true,
    },
  })

  // Parse event times into UTC timestamps, filtering out unparseable ones
  const parsedEvents: ParsedEvent[] = []
  let skippedEvents = 0

  for (const row of econRows) {
    const time = parseEventTimeET(row.eventDate, row.eventTime)
    if (time) {
      parsedEvents.push({ time })
    } else {
      skippedEvents++
    }
  }

  console.log(`[backtest-event-phases] Total high/medium events: ${econRows.length}`)
  console.log(`[backtest-event-phases] Parsed events with valid times: ${parsedEvents.length}`)
  if (skippedEvents > 0) {
    console.log(`[backtest-event-phases] Skipped ${skippedEvents} events with unparseable times`)
  }

  if (parsedEvents.length === 0) {
    console.log('\nNo parseable high/medium impact events found. Cannot compute event proximity.')
    await prisma.$disconnect()
    return
  }

  // Sort events by time for efficient nearest-event lookup
  parsedEvents.sort((a, b) => a.time.getTime() - b.time.getTime())
  const eventTimesMs = parsedEvents.map((e) => e.time.getTime())

  // ─── Classify Each Setup by Proximity ────────────────────────────────────

  // Accumulators for pre-event and post-event buckets
  const preBuckets: Map<string, { tp1Hits: number; tp2Hits: number; total: number }> = new Map()
  const postBuckets: Map<string, { tp1Hits: number; tp2Hits: number; total: number }> = new Map()
  let baselineTp1 = 0
  let baselineTp2 = 0
  let baselineTotal = 0

  for (const bucket of BUCKET_BOUNDS) {
    preBuckets.set(bucket.label, { tp1Hits: 0, tp2Hits: 0, total: 0 })
    postBuckets.set(bucket.label, { tp1Hits: 0, tp2Hits: 0, total: 0 })
  }

  for (const setup of validSetups) {
    const goMs = setup.goTime.getTime()

    // Binary search for nearest event
    const { minutesBefore, minutesAfter } = findNearestEventMinutes(goMs, eventTimesMs)

    // Determine the minimum absolute proximity
    const minProximityMinutes = Math.min(
      minutesBefore ?? Infinity,
      minutesAfter ?? Infinity
    )

    const tp1 = setup.tp1Hit === true
    const tp2 = setup.tp2Hit === true

    // If far from any event, count as baseline
    if (minProximityMinutes > BASELINE_THRESHOLD_MIN) {
      baselineTotal++
      if (tp1) baselineTp1++
      if (tp2) baselineTp2++
      continue
    }

    // Bucket by pre-event proximity (upcoming event)
    if (minutesBefore !== null && minutesBefore <= BASELINE_THRESHOLD_MIN) {
      const bucket = findBucket(minutesBefore)
      if (bucket) {
        const acc = preBuckets.get(bucket)!
        acc.total++
        if (tp1) acc.tp1Hits++
        if (tp2) acc.tp2Hits++
      }
    }

    // Bucket by post-event proximity (event just happened)
    if (minutesAfter !== null && minutesAfter <= BASELINE_THRESHOLD_MIN) {
      const bucket = findBucket(minutesAfter)
      if (bucket) {
        const acc = postBuckets.get(bucket)!
        acc.total++
        if (tp1) acc.tp1Hits++
        if (tp2) acc.tp2Hits++
      }
    }
  }

  // ─── Compute Rates and Report ────────────────────────────────────────────

  const baselineTp1Rate = pct(baselineTp1, baselineTotal)
  const baselineTp2Rate = pct(baselineTp2, baselineTotal)

  console.log('')
  console.log('=== BHG Setup Outcomes by Event Proximity ===')
  console.log('')
  console.log(`Total setups with outcomes: ${validSetups.length}`)
  console.log(`Total high/medium econ events: ${parsedEvents.length}`)
  console.log(
    `Baseline (>${BASELINE_THRESHOLD_MIN} min from event): ${baselineTotal} setups, TP1 hit rate: ${baselineTp1Rate.toFixed(1)}%, TP2 hit rate: ${baselineTp2Rate.toFixed(1)}%`
  )

  // Pre-event table
  console.log('')
  console.log('--- Pre-Event (event upcoming) ---')
  const preStats = buildBucketStats(preBuckets, baselineTp1Rate)
  printBucketTable(preStats)

  // Post-event table
  console.log('')
  console.log('--- Post-Event (event just happened) ---')
  const postStats = buildBucketStats(postBuckets, baselineTp1Rate)
  printBucketTable(postStats)

  // ─── Derive Recommended Thresholds ───────────────────────────────────────

  console.log('')
  console.log('=== Recommended Thresholds ===')
  deriveThresholds(preStats, postStats, baselineTp1Rate)

  // ─── Derive Confidence Adjustments ───────────────────────────────────────

  console.log('')
  console.log('=== Recommended Confidence Adjustments ===')
  deriveConfidenceAdjustments(preStats, postStats, baselineTp1Rate)

  await prisma.$disconnect()
}

// ─── Nearest Event Search ────────────────────────────────────────────────────

/**
 * For a given goTime (in ms), find the number of minutes to the nearest
 * upcoming event (minutesBefore — event is in the future) and the number
 * of minutes since the nearest past event (minutesAfter — event already happened).
 *
 * Uses binary search on the sorted event times array.
 */
function findNearestEventMinutes(
  goMs: number,
  eventTimesMs: number[]
): { minutesBefore: number | null; minutesAfter: number | null } {
  // Binary search: find the index where goMs would be inserted
  let lo = 0
  let hi = eventTimesMs.length

  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (eventTimesMs[mid] <= goMs) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  // lo is now the index of the first event AFTER goMs
  // lo - 1 is the last event AT or BEFORE goMs

  let minutesBefore: number | null = null // minutes until next upcoming event
  let minutesAfter: number | null = null // minutes since last past event

  // Nearest upcoming event (event is in the future relative to goTime)
  if (lo < eventTimesMs.length) {
    minutesBefore = (eventTimesMs[lo] - goMs) / 60_000
  }

  // Nearest past event (event already happened relative to goTime)
  if (lo > 0) {
    minutesAfter = (goMs - eventTimesMs[lo - 1]) / 60_000
  }

  return { minutesBefore, minutesAfter }
}

/**
 * Find which bucket label a proximity value (in minutes) falls into.
 */
function findBucket(minutes: number): string | null {
  for (const b of BUCKET_BOUNDS) {
    if (minutes >= b.min && minutes < b.max) return b.label
  }
  // Falls outside defined buckets (e.g. 120+ is baseline)
  return null
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function buildBucketStats(
  buckets: Map<string, { tp1Hits: number; tp2Hits: number; total: number }>,
  baselineTp1Rate: number
): BucketStats[] {
  const stats: BucketStats[] = []

  for (const bucket of BUCKET_BOUNDS) {
    const acc = buckets.get(bucket.label)!
    const tp1Rate = pct(acc.tp1Hits, acc.total)
    const tp2Rate = pct(acc.tp2Hits, acc.total)
    const vsBaseline = acc.total > 0 ? tp1Rate - baselineTp1Rate : 0

    stats.push({
      label: bucket.label,
      setups: acc.total,
      tp1Hits: acc.tp1Hits,
      tp2Hits: acc.tp2Hits,
      tp1Rate,
      tp2Rate,
      vsBaseline,
      lowConfidence: acc.total < LOW_CONFIDENCE_THRESHOLD,
    })
  }

  return stats
}

function printBucketTable(stats: BucketStats[]): void {
  const header = `${pad('Bucket', 14)}| ${padLeft('Setups', 6)} | ${padLeft('TP1 Rate', 9)} | ${padLeft('vs Baseline', 11)} | ${padLeft('TP2 Rate', 9)}`
  console.log(header)
  console.log('-'.repeat(header.length))

  for (const row of stats) {
    const flag = row.lowConfidence ? ' *' : ''
    console.log(
      `${pad(row.label, 14)}| ${padLeft(String(row.setups), 6)} | ${padLeft(row.tp1Rate.toFixed(1) + '%', 9)} | ${padLeft(fmtPct(row.vsBaseline), 11)} | ${padLeft(row.tp2Rate.toFixed(1) + '%', 9)}${flag}`
    )
  }

  const hasLowConf = stats.some((s) => s.lowConfidence)
  if (hasLowConf) {
    console.log(`  * = low confidence (fewer than ${LOW_CONFIDENCE_THRESHOLD} setups)`)
  }
}

// ─── Threshold Derivation ────────────────────────────────────────────────────

function deriveThresholds(
  preStats: BucketStats[],
  postStats: BucketStats[],
  baselineTp1Rate: number
): void {
  // APPROACHING: starts where hit rate drops >10% vs baseline (pre-event)
  // Walk from the farthest bucket inward until we find a significant drop
  const approachingMin = findInflection(preStats, -10)
  const imminentMin = findInflection(preStats, -25)

  // BLACKOUT_BEFORE: the smallest pre-event bucket where hit rate drops >40%
  const blackoutBeforeMin = findInflection(preStats, -40)

  // BLACKOUT_AFTER: the smallest post-event bucket where hit rate drops >40%
  const blackoutAfterMin = findInflection(postStats, -40)

  // DIGESTING ends: first post-event bucket that normalizes within 5% of baseline
  const digestingEndMin = findNormalization(postStats, 5)

  console.log(
    `APPROACHING: starts at ${approachingMin !== null ? approachingMin + ' min before' : 'N/A (no significant drop detected)'} (hit rate drops > 10% vs baseline)`
  )
  console.log(
    `IMMINENT: starts at ${imminentMin !== null ? imminentMin + ' min before' : 'N/A (no significant drop detected)'} (hit rate drops > 25% vs baseline)`
  )
  console.log(
    `BLACKOUT_BEFORE: ${blackoutBeforeMin !== null ? blackoutBeforeMin + ' min before release' : 'N/A'}`
  )
  console.log(
    `BLACKOUT_AFTER: ${blackoutAfterMin !== null ? blackoutAfterMin + ' min after release' : 'N/A'}`
  )
  console.log(
    `DIGESTING: ends at ${digestingEndMin !== null ? digestingEndMin + ' min after' : 'N/A'} (hit rate normalizes to within 5% of baseline)`
  )
}

/**
 * Walk buckets from farthest to closest, return the upper bound of the
 * first bucket whose vsBaseline exceeds the threshold (negative number).
 * Returns null if no bucket hits the threshold.
 */
function findInflection(stats: BucketStats[], thresholdPct: number): number | null {
  // Walk from farthest (60-120) to closest (0-5)
  const reversed = [...stats].reverse()

  for (const row of reversed) {
    if (row.setups < LOW_CONFIDENCE_THRESHOLD) continue
    if (row.vsBaseline <= thresholdPct) {
      // Return the upper bound of this bucket as the threshold
      const bucket = BUCKET_BOUNDS.find((b) => b.label === row.label)
      return bucket ? bucket.max : null
    }
  }

  return null
}

/**
 * Walk post-event buckets from closest to farthest, return the upper bound
 * of the first bucket whose hit rate is within `withinPct` of baseline.
 * This identifies when the market has "normalized" after an event.
 */
function findNormalization(stats: BucketStats[], withinPct: number): number | null {
  for (const row of stats) {
    if (row.setups < LOW_CONFIDENCE_THRESHOLD) continue
    if (Math.abs(row.vsBaseline) <= withinPct) {
      const bucket = BUCKET_BOUNDS.find((b) => b.label === row.label)
      return bucket ? bucket.max : null
    }
  }

  return null
}

// ─── Confidence Adjustment Derivation ────────────────────────────────────────

function deriveConfidenceAdjustments(
  preStats: BucketStats[],
  postStats: BucketStats[],
  baselineTp1Rate: number
): void {
  console.log(`CLEAR: 1.00`)

  // APPROACHING: average hit rate of buckets 15-60 min pre-event
  const approachingAdj = computeWeightedAdj(preStats, 15, 60, baselineTp1Rate)
  console.log(
    `APPROACHING: ${approachingAdj !== null ? approachingAdj.toFixed(2) : 'N/A'} (hitRate / baseline)`
  )

  // IMMINENT: average hit rate of buckets 5-15 min pre-event
  const imminentAdj = computeWeightedAdj(preStats, 5, 15, baselineTp1Rate)
  console.log(
    `IMMINENT: ${imminentAdj !== null ? imminentAdj.toFixed(2) : 'N/A'} (hitRate / baseline)`
  )

  // BLACKOUT: always 0
  console.log(`BLACKOUT: 0.00`)

  // DIGESTING: average hit rate of buckets 5-30 min post-event
  const digestingAdj = computeWeightedAdj(postStats, 5, 30, baselineTp1Rate)
  console.log(
    `DIGESTING: ${digestingAdj !== null ? digestingAdj.toFixed(2) : 'N/A'} (hitRate / baseline)`
  )

  // SETTLED: average hit rate of buckets 30-120 min post-event
  const settledAdj = computeWeightedAdj(postStats, 30, 120, baselineTp1Rate)
  console.log(
    `SETTLED: ${settledAdj !== null ? settledAdj.toFixed(2) : 'N/A'} (hitRate / baseline)`
  )
}

/**
 * Compute sample-weighted TP1 hit rate across buckets in the [fromMin, toMin)
 * range, then return that rate divided by the baseline rate.
 *
 * Returns null if no qualifying samples exist.
 */
function computeWeightedAdj(
  stats: BucketStats[],
  fromMin: number,
  toMin: number,
  baselineTp1Rate: number
): number | null {
  let totalSetups = 0
  let totalTp1Hits = 0

  for (const row of stats) {
    const bucket = BUCKET_BOUNDS.find((b) => b.label === row.label)
    if (!bucket) continue

    // Include buckets that overlap with [fromMin, toMin)
    if (bucket.max <= fromMin || bucket.min >= toMin) continue

    totalSetups += row.setups
    totalTp1Hits += row.tp1Hits
  }

  if (totalSetups < LOW_CONFIDENCE_THRESHOLD || baselineTp1Rate === 0) return null

  const weightedRate = pct(totalTp1Hits, totalSetups)
  return weightedRate / baselineTp1Rate
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[backtest-event-phases] Fatal error:', err)
  process.exit(1)
})
