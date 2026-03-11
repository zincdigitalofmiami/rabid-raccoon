/**
 * Event Awareness Engine
 *
 * Reads the econ_calendar table and produces real-time event context
 * for trade decisions. Given a timestamp, determines the current "event phase"
 * relative to the nearest high/medium-impact economic event.
 *
 * Time windows and confidence adjustments are currently configured constants.
 */

import { Decimal } from '@prisma/client/runtime/client'

import { prisma } from '@/lib/prisma'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape of a row from the Prisma econ_calendar table */
export interface EventRow {
  eventDate: Date
  eventTime: string | null
  eventName: string
  impactRating: string | null
  actual: Decimal | null
  forecast: Decimal | null
  previous: Decimal | null
  surprise: Decimal | null
}

export interface EventInfo {
  name: string
  impact: 'high' | 'medium' | 'low'
  time: Date
  actual: number | null
  forecast: number | null
  surprise: number | null
}

export type EventPhase =
  | 'CLEAR'
  | 'APPROACHING'
  | 'IMMINENT'
  | 'BLACKOUT'
  | 'SHOCK'
  | 'DIGESTION'
  | 'SETTLED'

export interface SurpriseData {
  zScore: number
  direction: 'BEAT' | 'MISS' | 'INLINE'
}

export interface EventContext {
  phase: EventPhase
  event: EventInfo | null
  minutesToEvent: number | null
  minutesSinceEvent: number | null
  surprise: SurpriseData | null
  confidenceAdjustment: number // multiplier, 1.0 = no change
  label: string // human-readable, e.g. "ISM Manufacturing in 32 min — expect compression"
  // Enhanced fields for AI reasoning
  eventName: string | null
  expectedImpact: 'HIGH' | 'MEDIUM' | 'LOW' | null
  forecast: number | null
  previous: number | null
  surpriseHistory: number | null // avg |surprise| from last 6 releases of same event
  marketTemperature: 'risk-on' | 'risk-off' | 'neutral' | null
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Minutes before event: transition to APPROACHING phase */
const APPROACH_WINDOW_MIN = 60

/** Minutes before event: transition to IMMINENT phase */
const IMMINENT_WINDOW_MIN = 10

/** Minutes before event: transition to BLACKOUT (no-trade zone) */
const BLACKOUT_BEFORE_MIN = 3

/** Minutes after event: BLACKOUT zone ends */
const BLACKOUT_AFTER_MIN = 5

/** Minutes after event: DIGESTION phase ends, transitions to SETTLED */
const DIGESTION_WINDOW_MIN = 45

/** Minutes after event: SETTLED phase ends, transitions to CLEAR */
const SETTLED_WINDOW_MIN = 90

/** Confidence multipliers per phase */
const CONFIDENCE_ADJ: Record<EventPhase, number> = {
  CLEAR: 1.0,
  APPROACHING: 0.85,
  IMMINENT: 0.5,
  BLACKOUT: 0.0,
  SHOCK: 0.0,
  DIGESTION: 0.6,
  SETTLED: 0.9,
}

/** Threshold for z-score to be considered "inline" (not a beat/miss) */
const INLINE_ZSCORE_THRESHOLD = 0.3

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse an eventTime string like "08:30 ET" or "14:00 ET" into a full Date
 * by combining it with the eventDate. Handles EST/EDT correctly using the
 * US DST rules: DST starts second Sunday of March, ends first Sunday of November.
 *
 * Returns null for unparseable times (e.g. "After Close", "Tentative", null).
 */
function parseEventTimeET(eventDate: Date, eventTime: string | null): Date | null {
  if (!eventTime) return null

  // Match patterns like "08:30 ET", "14:00 ET", "8:30 ET"
  const match = eventTime.match(/^(\d{1,2}):(\d{2})\s*ET$/i)
  if (!match) return null

  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null

  // Determine if eventDate falls within US Eastern Daylight Time (EDT = UTC-4)
  // or Eastern Standard Time (EST = UTC-5).
  //
  // DST starts: second Sunday of March at 2:00 AM local
  // DST ends:   first Sunday of November at 2:00 AM local
  const year = eventDate.getUTCFullYear()
  const month = eventDate.getUTCMonth() // 0-indexed
  const day = eventDate.getUTCDate()

  const isDST = isEasternDST(year, month, day)
  const utcOffsetHours = isDST ? -4 : -5

  // Build UTC timestamp: local ET time minus the offset
  // e.g. 08:30 ET during EDT (UTC-4) → 08:30 + 4 = 12:30 UTC
  const utcDate = new Date(Date.UTC(year, month, day, hours - utcOffsetHours, minutes, 0, 0))
  return utcDate
}

/**
 * Determine if a given date (year, 0-indexed month, day) falls within
 * US Eastern Daylight Time using standard DST rules:
 *   - Starts: second Sunday of March at 2:00 AM
 *   - Ends:   first Sunday of November at 2:00 AM
 *
 * For boundary dates (the exact switch days), we simplify by treating
 * the entire day as DST-on for March switch day and DST-off for November
 * switch day. The event times we care about (market hours) do not overlap
 * with the 2:00 AM switch time.
 */
function isEasternDST(year: number, month: number, day: number): boolean {
  // Before March or after November → EST
  if (month < 2 || month > 10) return false
  // April through October → EDT
  if (month > 2 && month < 10) return true

  if (month === 2) {
    // March: DST starts on second Sunday
    const secondSunday = getSecondSundayOfMarch(year)
    return day >= secondSunday
  }

  // month === 10 → November: DST ends on first Sunday
  const firstSunday = getFirstSundayOfNovember(year)
  return day < firstSunday
}

/** Get the day-of-month of the second Sunday in March for a given year */
function getSecondSundayOfMarch(year: number): number {
  // March 1st day of week (0=Sun, 6=Sat)
  const march1 = new Date(Date.UTC(year, 2, 1)).getUTCDay()
  // First Sunday: if March 1 is Sunday → 1, else 8 - march1
  const firstSunday = march1 === 0 ? 1 : 8 - march1
  return firstSunday + 7
}

/** Get the day-of-month of the first Sunday in November for a given year */
function getFirstSundayOfNovember(year: number): number {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  return nov1 === 0 ? 1 : 8 - nov1
}

/** Safely convert a Prisma Decimal to number, or return null */
function decimalToNum(val: Decimal | null): number | null {
  if (val === null || val === undefined) return null
  return val.toNumber()
}

/** Convert an EventRow + parsed time into an EventInfo */
function toEventInfo(row: EventRow, parsedTime: Date): EventInfo {
  const impact = normalizeImpact(row.impactRating)
  return {
    name: row.eventName,
    impact,
    time: parsedTime,
    actual: decimalToNum(row.actual),
    forecast: decimalToNum(row.forecast),
    surprise: decimalToNum(row.surprise),
  }
}

/** Normalize impactRating string to the union type */
function normalizeImpact(rating: string | null): 'high' | 'medium' | 'low' {
  const lower = (rating ?? '').toLowerCase()
  if (lower === 'high') return 'high'
  if (lower === 'medium') return 'medium'
  return 'low'
}

// ─── Core: getEventContext (pure function) ────────────────────────────────────

/**
 * Given the current time and a list of today's event rows, determine the
 * event phase, nearest event info, timing data, surprise scoring, and
 * confidence adjustment.
 *
 * This is a pure function (no DB calls) for testability.
 * Optional enrichment params are passed through to the context.
 */
export function getEventContext(
  now: Date,
  events: EventRow[],
  enrichment?: { surpriseHistory?: number | null; marketTemperature?: 'risk-on' | 'risk-off' | 'neutral' | null },
): EventContext {
  // Parse all events into (EventRow, parsedTime) pairs, filtering out
  // unparseable times and low-impact events
  const parsed: Array<{ row: EventRow; time: Date }> = []
  for (const row of events) {
    const impact = normalizeImpact(row.impactRating)
    if (impact === 'low') continue // Only track high/medium impact events

    const time = parseEventTimeET(row.eventDate, row.eventTime)
    if (!time) continue
    parsed.push({ row, time })
  }

  // If no parseable high/medium events, we're CLEAR
  if (parsed.length === 0) {
    return buildClearContext()
  }

  // Find the nearest upcoming event and the nearest past event
  let nearestUpcoming: { row: EventRow; time: Date } | null = null
  let nearestPast: { row: EventRow; time: Date } | null = null

  for (const entry of parsed) {
    const diff = entry.time.getTime() - now.getTime()
    if (diff > 0) {
      // Future event
      if (!nearestUpcoming || diff < nearestUpcoming.time.getTime() - now.getTime()) {
        nearestUpcoming = entry
      }
    } else {
      // Past or current event
      if (!nearestPast || Math.abs(diff) < Math.abs(nearestPast.time.getTime() - now.getTime())) {
        nearestPast = entry
      }
    }
  }

  // Determine phase by checking post-event phases first (past event),
  // then pre-event phases (upcoming event).
  // Post-event phases take priority because a release that just happened
  // is more relevant than an upcoming event.
  if (nearestPast) {
    const msSince = now.getTime() - nearestPast.time.getTime()
    const minutesSince = msSince / 60_000

    if (minutesSince <= BLACKOUT_AFTER_MIN) {
      // Immediate post-release shock takes precedence over normal setup logic.
      const info = toEventInfo(nearestPast.row, nearestPast.time)
      return buildContext('SHOCK', info, null, minutesSince, nearestPast.row, {
        label: `${info.name} just released — SHOCK (${Math.ceil(BLACKOUT_AFTER_MIN - minutesSince)} min remaining)`,
        ...enrichment,
      })
    }

    if (minutesSince <= DIGESTION_WINDOW_MIN) {
      const info = toEventInfo(nearestPast.row, nearestPast.time)
      return buildContext('DIGESTION', info, null, minutesSince, nearestPast.row, {
        label: `Digesting ${info.name} (${Math.round(minutesSince)} min ago)`,
        ...enrichment,
      })
    }

    if (minutesSince <= SETTLED_WINDOW_MIN) {
      const info = toEventInfo(nearestPast.row, nearestPast.time)
      return buildContext('SETTLED', info, null, minutesSince, nearestPast.row, {
        label: `${info.name} settling (${Math.round(minutesSince)} min ago)`,
        ...enrichment,
      })
    }
  }

  // Check upcoming event phases
  if (nearestUpcoming) {
    const msUntil = nearestUpcoming.time.getTime() - now.getTime()
    const minutesUntil = msUntil / 60_000
    const info = toEventInfo(nearestUpcoming.row, nearestUpcoming.time)

    if (minutesUntil <= BLACKOUT_BEFORE_MIN) {
      return buildContext('BLACKOUT', info, minutesUntil, null, nearestUpcoming.row, {
        label: `${info.name} imminent — BLACKOUT (${Math.ceil(minutesUntil)} min)`,
        ...enrichment,
      })
    }

    if (minutesUntil <= IMMINENT_WINDOW_MIN) {
      return buildContext('IMMINENT', info, minutesUntil, null, nearestUpcoming.row, {
        label: `${info.name} IMMINENT in ${Math.round(minutesUntil)} min`,
        ...enrichment,
      })
    }

    if (minutesUntil <= APPROACH_WINDOW_MIN) {
      return buildContext('APPROACHING', info, minutesUntil, null, nearestUpcoming.row, {
        label: `${info.name} in ${Math.round(minutesUntil)} min — expect compression`,
        ...enrichment,
      })
    }
  }

  // No event within any window
  return buildClearContext()
}

// ─── Context builders ─────────────────────────────────────────────────────────

function buildClearContext(): EventContext {
  return {
    phase: 'CLEAR',
    event: null,
    minutesToEvent: null,
    minutesSinceEvent: null,
    surprise: null,
    confidenceAdjustment: CONFIDENCE_ADJ.CLEAR,
    label: 'No nearby events',
    eventName: null,
    expectedImpact: null,
    forecast: null,
    previous: null,
    surpriseHistory: null,
    marketTemperature: null,
  }
}

function buildContext(
  phase: EventPhase,
  event: EventInfo,
  minutesToEvent: number | null,
  minutesSinceEvent: number | null,
  row: EventRow,
  opts: { label: string; surpriseHistory?: number | null; marketTemperature?: 'risk-on' | 'risk-off' | 'neutral' | null }
): EventContext {
  const surprise = computeSurprise(row)

  return {
    phase,
    event,
    minutesToEvent: minutesToEvent !== null ? Math.round(minutesToEvent * 100) / 100 : null,
    minutesSinceEvent: minutesSinceEvent !== null ? Math.round(minutesSinceEvent * 100) / 100 : null,
    surprise,
    confidenceAdjustment: CONFIDENCE_ADJ[phase],
    label: opts.label,
    eventName: row.eventName,
    expectedImpact: normalizeImpact(row.impactRating).toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW',
    forecast: decimalToNum(row.forecast),
    previous: decimalToNum(row.previous),
    surpriseHistory: opts.surpriseHistory ?? null,
    marketTemperature: opts.marketTemperature ?? null,
  }
}

// ─── Surprise scoring ─────────────────────────────────────────────────────────

/**
 * Compute surprise direction from event data.
 *
 * Uses pre-computed `surprise` field if available (treated as z-score proxy).
 * Falls back to `actual - forecast` if both are present.
 * Returns null if insufficient data.
 */
function computeSurprise(row: EventRow): SurpriseData | null {
  const actual = decimalToNum(row.actual)
  const forecast = decimalToNum(row.forecast)
  const precomputed = decimalToNum(row.surprise)

  // If we have a pre-computed surprise value, use it directly as a z-score proxy
  if (precomputed !== null) {
    return {
      zScore: precomputed,
      direction: classifySurprise(precomputed),
    }
  }

  // Fall back to actual vs forecast
  if (actual !== null && forecast !== null && forecast !== 0) {
    // Compute a simple percentage surprise as a z-score proxy.
    // A proper z-score requires historical std dev — that's a future enhancement.
    const rawDiff = actual - forecast
    const zScoreProxy = rawDiff / Math.abs(forecast) // BACKTEST-TBD: replace with proper z-score using historical std dev
    return {
      zScore: Math.round(zScoreProxy * 1000) / 1000,
      direction: classifySurprise(zScoreProxy),
    }
  }

  // No surprise data available (event hasn't released or forecast missing)
  return null
}

function classifySurprise(zScore: number): 'BEAT' | 'MISS' | 'INLINE' {
  if (Math.abs(zScore) <= INLINE_ZSCORE_THRESHOLD) return 'INLINE' // BACKTEST-TBD
  return zScore > 0 ? 'BEAT' : 'MISS'
}

// ─── Surprise history ─────────────────────────────────────────────────────────

/**
 * Fetch avg |surprise| from the last 6 releases of the same event.
 * Used to gauge how "noisy" this particular release tends to be.
 */
export async function fetchSurpriseHistory(eventName: string): Promise<number | null> {
  try {
    const rows = await prisma.econCalendar.findMany({
      where: {
        eventName,
        surprise: { not: null },
      },
      select: { surprise: true },
      orderBy: { eventDate: 'desc' },
      take: 6,
    })

    if (rows.length === 0) return null

    const absValues = rows
      .map((r) => r.surprise)
      .filter((s): s is Decimal => s !== null)
      .map((s) => Math.abs(s.toNumber()))

    if (absValues.length === 0) return null
    return Math.round((absValues.reduce((a, b) => a + b, 0) / absValues.length) * 10000) / 10000
  } catch {
    return null
  }
}

// ─── Database: loadTodayEvents ────────────────────────────────────────────────

/** Per-day cache: key is ISO date string (YYYY-MM-DD), value is event rows */
let cachedDateKey: string | null = null
let cachedEvents: EventRow[] = []

/**
 * Load today's economic events from the econ_calendar table.
 * Results are cached per calendar day (Eastern Time) — the first call
 * hits the DB, subsequent calls on the same day return the cache.
 *
 * Pass `forceRefresh: true` to bypass the cache.
 */
export async function loadTodayEvents(opts?: { forceRefresh?: boolean }): Promise<EventRow[]> {
  // Determine "today" in Eastern Time for the cache key.
  // We approximate by using UTC minus 5 hours (EST). The exact offset
  // (EST vs EDT) doesn't matter much here since the only edge case is
  // around midnight ET, and no economic events release at that hour.
  const nowUtc = new Date()
  const etApproxMs = nowUtc.getTime() - 5 * 60 * 60 * 1000
  const etApprox = new Date(etApproxMs)
  const dateKey = etApprox.toISOString().slice(0, 10)

  if (!opts?.forceRefresh && cachedDateKey === dateKey) {
    return cachedEvents
  }

  // Query: all events for today's date
  const todayStart = new Date(`${dateKey}T00:00:00.000Z`)

  const rows = await prisma.econCalendar.findMany({
    where: {
      eventDate: todayStart,
    },
    select: {
      eventDate: true,
      eventTime: true,
      eventName: true,
      impactRating: true,
      actual: true,
      forecast: true,
      previous: true,
      surprise: true,
    },
    orderBy: {
      eventTime: 'asc',
    },
  })

  console.log(`[event-awareness] Loaded ${rows.length} events for ${dateKey}`)

  cachedDateKey = dateKey
  cachedEvents = rows
  return rows
}

/**
 * Reset the internal cache. Useful for testing.
 */
export function resetEventCache(): void {
  cachedDateKey = null
  cachedEvents = []
}
