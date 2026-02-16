import { prisma } from '@/lib/prisma'

// --- Types ---

type EconTable =
  | 'econRates1d'
  | 'econYields1d'
  | 'econInflation1d'
  | 'econLabor1d'
  | 'econActivity1d'
  | 'econMoney1d'
  | 'econVolIndices1d'

interface ReleaseSpec {
  releaseId: number
  eventName: string
  eventType: string
  impactRating: 'high' | 'medium' | 'low'
  source: string
  fredSeriesId: string
  frequency: string
  time: string
  table: EconTable
  /** If true, skip fetchReleaseDates and use FOMC_MEETING_DATES instead */
  useFomcDates?: boolean
}

interface ObservationRow {
  eventDate: Date
  value: { toNumber(): number } | number | null
}

function obsToNum(val: ObservationRow['value']): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  return val.toNumber()
}

// --- FOMC hardcoded meeting/decision dates ---
// FRED release 101 returns daily H.15 dates (351 junk rows).
// These are the actual FOMC rate decision announcement dates.
const FOMC_MEETING_DATES: string[] = [
  // 2020
  '2020-01-29', '2020-03-03', '2020-03-15', '2020-04-29', '2020-06-10',
  '2020-07-29', '2020-09-16', '2020-11-05', '2020-12-16',
  // 2021
  '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16',
  '2021-07-28', '2021-09-22', '2021-11-03', '2021-12-15',
  // 2022
  '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15',
  '2022-07-27', '2022-09-21', '2022-11-02', '2022-12-14',
  // 2023
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14',
  '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  // 2024
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12',
  '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  // 2025
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-17',
  // 2026
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-16',
]

// --- Release specs ---
// Tiered by MES impact: Tier 1 = high (50-150+ pt moves), Tier 2 = medium (20-60 pts), Tier 3 = low (10-30 pts)
// Fixed: NFP is release 50 (not 46), PPI is release 46 (not 51), release 51 = Trade Balance
const RELEASE_SPECS: ReleaseSpec[] = [
  // --- Tier 1: Market Movers (high) ---
  { releaseId: 101, eventName: 'FOMC Rate Decision', eventType: 'rate_decision', impactRating: 'high', source: 'Fed', fredSeriesId: 'DFF', frequency: '8x_year', time: '14:00 ET', table: 'econRates1d', useFomcDates: true },
  { releaseId: 50, eventName: 'NFP', eventType: 'employment', impactRating: 'high', source: 'BLS', fredSeriesId: 'PAYEMS', frequency: 'monthly', time: '08:30 ET', table: 'econLabor1d' },
  { releaseId: 10, eventName: 'CPI', eventType: 'inflation', impactRating: 'high', source: 'BLS', fredSeriesId: 'CPIAUCSL', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },
  { releaseId: 53, eventName: 'PCE', eventType: 'inflation', impactRating: 'high', source: 'BEA', fredSeriesId: 'PCEPI', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },

  // --- Tier 2: Significant Movers (medium) ---
  { releaseId: 46, eventName: 'PPI', eventType: 'inflation', impactRating: 'medium', source: 'BLS', fredSeriesId: 'PPIACO', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },
  { releaseId: 9, eventName: 'Retail Sales', eventType: 'retail', impactRating: 'medium', source: 'Census', fredSeriesId: 'RSXFS', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 21, eventName: 'GDP', eventType: 'gdp', impactRating: 'medium', source: 'BEA', fredSeriesId: 'GDPC1', frequency: 'quarterly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 180, eventName: 'Jobless Claims', eventType: 'employment', impactRating: 'medium', source: 'DOL', fredSeriesId: 'ICSA', frequency: 'weekly', time: '08:30 ET', table: 'econLabor1d' },
  { releaseId: 192, eventName: 'JOLTS', eventType: 'employment', impactRating: 'medium', source: 'BLS', fredSeriesId: 'JTSJOL', frequency: 'monthly', time: '10:00 ET', table: 'econLabor1d' },

  // --- Tier 3: Conditional Movers (low) ---
  { releaseId: 54, eventName: 'UMich Consumer Sentiment', eventType: 'sentiment', impactRating: 'low', source: 'UMich', fredSeriesId: 'UMCSENT', frequency: 'monthly', time: '10:00 ET', table: 'econActivity1d' },
  { releaseId: 95, eventName: 'Durable Goods Orders', eventType: 'manufacturing', impactRating: 'low', source: 'Census', fredSeriesId: 'DGORDER', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 27, eventName: 'Housing Starts', eventType: 'housing', impactRating: 'low', source: 'Census', fredSeriesId: 'HOUST', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 97, eventName: 'New Home Sales', eventType: 'housing', impactRating: 'low', source: 'Census', fredSeriesId: 'HSN1F', frequency: 'monthly', time: '10:00 ET', table: 'econActivity1d' },
  // Existing Home Sales (291) omitted — FRED release/dates API returns 0 dates for this release
  { releaseId: 194, eventName: 'ADP Employment', eventType: 'employment', impactRating: 'low', source: 'ADP', fredSeriesId: 'ADPWNUSNERSA', frequency: 'monthly', time: '08:15 ET', table: 'econLabor1d' },
  { releaseId: 13, eventName: 'Industrial Production', eventType: 'manufacturing', impactRating: 'low', source: 'Fed', fredSeriesId: 'INDPRO', frequency: 'monthly', time: '09:15 ET', table: 'econActivity1d' },
  { releaseId: 51, eventName: 'Trade Balance', eventType: 'trade', impactRating: 'low', source: 'BEA', fredSeriesId: 'BOPGSTB', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 229, eventName: 'Construction Spending', eventType: 'housing', impactRating: 'low', source: 'Census', fredSeriesId: 'TTLCONS', frequency: 'monthly', time: '10:00 ET', table: 'econActivity1d' },
  { releaseId: 18, eventName: 'Interest Rates', eventType: 'rates', impactRating: 'low', source: 'Fed', fredSeriesId: 'DGS10', frequency: 'daily', time: '16:00 ET', table: 'econYields1d' },
]

// --- Earnings tickers ---
const EARNINGS_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'TSLA', 'AVGO', 'AMD', 'CRM']

// --- Helpers ---

interface FredReleaseDatesResponse {
  release_dates?: Array<{ date: string }>
}

function utcDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchReleaseDates(releaseId: number, apiKey: string, startDate: string): Promise<string[]> {
  const url = new URL('https://api.stlouisfed.org/fred/release/dates')
  url.searchParams.set('release_id', String(releaseId))
  url.searchParams.set('realtime_start', startDate)
  url.searchParams.set('include_release_dates_with_no_data', 'false')
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')

  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`FRED release dates failed (${releaseId}) ${res.status}: ${body.slice(0, 240)}`)
  }

  const json = (await res.json()) as FredReleaseDatesResponse
  const dates = json.release_dates?.map((d) => d.date).filter(Boolean) ?? []
  return [...new Set(dates)]
}

/**
 * Load observations sorted ascending for nearest-prior lookup.
 * Monthly series: observation date = 1st of month, release date ≈ 13th-15th of next month.
 */
async function loadSeriesObservations(
  table: EconTable,
  seriesId: string,
  startDate: Date
): Promise<ObservationRow[]> {
  const where = { seriesId, eventDate: { gte: startDate } }
  const orderBy = { eventDate: 'asc' as const }
  const select = { eventDate: true, value: true }

  switch (table) {
    case 'econRates1d':
      return prisma.econRates1d.findMany({ where, orderBy, select })
    case 'econYields1d':
      return prisma.econYields1d.findMany({ where, orderBy, select })
    case 'econInflation1d':
      return prisma.econInflation1d.findMany({ where, orderBy, select })
    case 'econLabor1d':
      return prisma.econLabor1d.findMany({ where, orderBy, select })
    case 'econActivity1d':
      return prisma.econActivity1d.findMany({ where, orderBy, select })
    case 'econMoney1d':
      return prisma.econMoney1d.findMany({ where, orderBy, select })
    case 'econVolIndices1d':
      return prisma.econVolIndices1d.findMany({ where, orderBy, select })
  }
}

/**
 * Find the most recent observation value on or before the given release date.
 * Observations must be sorted ascending by date.
 */
function findNearestPriorActual(observations: ObservationRow[], releaseDate: Date): number | undefined {
  let best: ObservationRow | undefined
  for (const obs of observations) {
    if (obs.eventDate <= releaseDate) {
      best = obs
    } else {
      break
    }
  }
  return best ? obsToNum(best.value) : undefined
}

// --- Yahoo Finance earnings ---

interface YahooEarningsQuarter {
  date: string
  epsActual?: number
  epsEstimate?: number
  epsSurprise?: number
}

async function fetchEarningsHistory(ticker: string): Promise<YahooEarningsQuarter[]> {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory,calendarEvents`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cache: 'no-store',
  })

  if (!res.ok) return []

  try {
    const json = await res.json()
    const result = json?.quoteSummary?.result?.[0]
    const quarters: YahooEarningsQuarter[] = []

    const history = result?.earningsHistory?.history
    if (Array.isArray(history)) {
      for (const q of history) {
        const dateStr = q?.quarter?.fmt
        if (!dateStr) continue
        quarters.push({
          date: dateStr,
          epsActual: q?.epsActual?.raw,
          epsEstimate: q?.epsEstimate?.raw,
          epsSurprise: q?.epsSurprise?.raw,
        })
      }
    }

    const earningsDate = result?.calendarEvents?.earnings?.earningsDate
    if (Array.isArray(earningsDate)) {
      for (const d of earningsDate) {
        const dateStr = d?.fmt
        if (!dateStr) continue
        if (!quarters.some((q) => q.date === dateStr)) {
          quarters.push({
            date: dateStr,
            epsEstimate: result?.calendarEvents?.earnings?.earningsAverage?.raw,
          })
        }
      }
    }

    return quarters
  } catch {
    return []
  }
}

// --- Main ingestion logic (exported for Inngest) ---

export interface EconCalendarIngestResult {
  ok: boolean
  startDate: string
  endDate: string | null
  releases: number
  processed: number
  inserted: number
  updated: number
  earningsProcessed: number
  earningsInserted: number
  releaseErrors: Array<{ releaseId: number; eventName: string; error: string }>
  earningsErrors: Array<{ ticker: string; error: string }>
}

export interface EconCalendarIngestOptions {
  startDateStr?: string
  endDateStr?: string
  releaseIds?: number[]
  includeEarnings?: boolean
  earningsTickers?: string[]
  continueOnError?: boolean
}

interface NormalizedEconCalendarIngestOptions {
  startDateStr: string
  endDateStr?: string
  releaseIds?: number[]
  includeEarnings: boolean
  earningsTickers?: string[]
  continueOnError: boolean
}

function normalizeOptions(
  input: string | EconCalendarIngestOptions | undefined
): NormalizedEconCalendarIngestOptions {
  if (typeof input === 'string') {
    return {
      startDateStr: input,
      endDateStr: undefined,
      includeEarnings: true,
      continueOnError: false,
      releaseIds: undefined,
      earningsTickers: undefined,
    }
  }

  return {
    startDateStr: input?.startDateStr || '2020-01-01',
    endDateStr: input?.endDateStr,
    includeEarnings: input?.includeEarnings ?? true,
    continueOnError: input?.continueOnError ?? false,
    releaseIds: input?.releaseIds,
    earningsTickers: input?.earningsTickers,
  }
}

export async function runIngestEconCalendar(
  input: string | EconCalendarIngestOptions = '2020-01-01'
): Promise<EconCalendarIngestResult> {
  const options = normalizeOptions(input)
  const startDateStr = options.startDateStr
  const endDateStr = options.endDateStr
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY is required')

  const startDate = utcDateOnly(startDateStr)
  if (endDateStr && endDateStr < startDateStr) {
    throw new Error(`Invalid date window: endDateStr (${endDateStr}) is before startDateStr (${startDateStr})`)
  }
  const hasReleaseFilter = Array.isArray(options.releaseIds)
  const selectedReleases =
    hasReleaseFilter
      ? RELEASE_SPECS.filter((spec) => options.releaseIds?.includes(spec.releaseId))
      : RELEASE_SPECS
  const releaseErrors: Array<{ releaseId: number; eventName: string; error: string }> = []

  // Pre-load observation data for nearest-prior actual lookup
  const observationCache = new Map<string, ObservationRow[]>()
  for (const spec of selectedReleases) {
    if (!observationCache.has(spec.fredSeriesId)) {
      observationCache.set(
        spec.fredSeriesId,
        await loadSeriesObservations(spec.table, spec.fredSeriesId, startDate)
      )
    }
  }

  let processed = 0
  let inserted = 0
  let updated = 0

  for (const spec of selectedReleases) {
    try {
      let dates: string[]
      if (spec.useFomcDates) {
        dates = FOMC_MEETING_DATES.filter((d) => d >= startDateStr && (!endDateStr || d <= endDateStr))
      } else {
        dates = await fetchReleaseDates(spec.releaseId, apiKey, startDateStr)
        if (endDateStr) {
          dates = dates.filter((d) => d <= endDateStr)
        }
      }

      const observations = observationCache.get(spec.fredSeriesId) || []

      for (const dateStr of dates) {
        const eventDate = utcDateOnly(dateStr)
        const actual = findNearestPriorActual(observations, eventDate)

        const existing = await prisma.econCalendar.findUnique({
          where: { eventDate_eventName: { eventDate, eventName: spec.eventName } },
          select: { id: true },
        })

        await prisma.econCalendar.upsert({
          where: { eventDate_eventName: { eventDate, eventName: spec.eventName } },
          create: {
            eventDate,
            eventTime: spec.time,
            eventName: spec.eventName,
            eventType: spec.eventType,
            fredReleaseId: spec.releaseId,
            fredSeriesId: spec.fredSeriesId,
            frequency: spec.frequency,
            actual,
            impactRating: spec.impactRating,
            source: spec.source,
            metadata: { ingest: 'fred-release-dates' },
          },
          update: {
            eventTime: spec.time,
            eventType: spec.eventType,
            fredReleaseId: spec.releaseId,
            fredSeriesId: spec.fredSeriesId,
            frequency: spec.frequency,
            actual,
            impactRating: spec.impactRating,
            source: spec.source,
            knowledgeTime: new Date(),
          },
        })

        processed += 1
        if (existing) updated += 1
        else inserted += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      releaseErrors.push({
        releaseId: spec.releaseId,
        eventName: spec.eventName,
        error: message.slice(0, 400),
      })
      if (!options.continueOnError) throw error
    } finally {
      await sleep(550)
    }
  }

  // --- Earnings for top AI/tech stocks ---
  let earningsProcessed = 0
  let earningsInserted = 0
  const earningsErrors: Array<{ ticker: string; error: string }> = []
  const tickers =
    options.earningsTickers && options.earningsTickers.length > 0
      ? options.earningsTickers
      : EARNINGS_TICKERS

  if (options.includeEarnings) {
    for (const ticker of tickers) {
      try {
        const quarters = await fetchEarningsHistory(ticker)

        for (const q of quarters) {
          if (q.date < startDateStr) continue
          if (endDateStr && q.date > endDateStr) continue

          const eventDate = utcDateOnly(q.date)
          const eventName = `${ticker} Earnings`

          const existing = await prisma.econCalendar.findUnique({
            where: { eventDate_eventName: { eventDate, eventName } },
            select: { id: true },
          })

          await prisma.econCalendar.upsert({
            where: { eventDate_eventName: { eventDate, eventName } },
            create: {
              eventDate,
              eventTime: 'After Close',
              eventName,
              eventType: 'earnings',
              actual: q.epsActual,
              forecast: q.epsEstimate,
              surprise: q.epsSurprise,
              impactRating: 'high',
              source: 'Yahoo Finance',
              metadata: { ticker, ingest: 'yahoo-earnings' },
            },
            update: {
              actual: q.epsActual,
              forecast: q.epsEstimate,
              surprise: q.epsSurprise,
              knowledgeTime: new Date(),
            },
          })

          earningsProcessed += 1
          if (!existing) earningsInserted += 1
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        earningsErrors.push({ ticker, error: message.slice(0, 400) })
        if (!options.continueOnError) throw error
      } finally {
        await sleep(1000)
      }
    }
  }

  return {
    ok: true,
    startDate: startDateStr,
    endDate: endDateStr || null,
    releases: selectedReleases.length,
    processed,
    inserted,
    updated,
    earningsProcessed,
    earningsInserted,
    releaseErrors,
    earningsErrors,
  }
}
