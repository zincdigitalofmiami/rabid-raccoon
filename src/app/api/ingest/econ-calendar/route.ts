import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toNum } from '@/lib/decimal'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
}

const RELEASE_SPECS: ReleaseSpec[] = [
  { releaseId: 10, eventName: 'CPI', eventType: 'inflation', impactRating: 'high', source: 'BLS', fredSeriesId: 'CPIAUCSL', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },
  { releaseId: 46, eventName: 'NFP', eventType: 'employment', impactRating: 'high', source: 'BLS', fredSeriesId: 'PAYEMS', frequency: 'monthly', time: '08:30 ET', table: 'econLabor1d' },
  { releaseId: 101, eventName: 'FOMC Rate Decision', eventType: 'rate_decision', impactRating: 'high', source: 'Fed', fredSeriesId: 'EFFR', frequency: '8x_year', time: '14:00 ET', table: 'econRates1d' },
  { releaseId: 21, eventName: 'GDP', eventType: 'gdp', impactRating: 'high', source: 'BEA', fredSeriesId: 'GDPC1', frequency: 'quarterly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 53, eventName: 'PCE', eventType: 'inflation', impactRating: 'high', source: 'BEA', fredSeriesId: 'PCEPI', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },
  { releaseId: 51, eventName: 'PPI', eventType: 'inflation', impactRating: 'medium', source: 'BLS', fredSeriesId: 'PPIACO', frequency: 'monthly', time: '08:30 ET', table: 'econInflation1d' },
  { releaseId: 83, eventName: 'Retail Sales', eventType: 'retail', impactRating: 'medium', source: 'Census', fredSeriesId: 'RSAFS', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 13, eventName: 'Industrial Production', eventType: 'manufacturing', impactRating: 'medium', source: 'Fed', fredSeriesId: 'INDPRO', frequency: 'monthly', time: '09:15 ET', table: 'econActivity1d' },
  { releaseId: 54, eventName: 'UMich Consumer Sentiment', eventType: 'sentiment', impactRating: 'low', source: 'UMich', fredSeriesId: 'UMCSENT', frequency: 'monthly', time: '10:00 ET', table: 'econActivity1d' },
  { releaseId: 29, eventName: 'Housing Starts', eventType: 'housing', impactRating: 'low', source: 'Census', fredSeriesId: 'HOUST', frequency: 'monthly', time: '08:30 ET', table: 'econActivity1d' },
  { releaseId: 202, eventName: 'Jobless Claims', eventType: 'employment', impactRating: 'medium', source: 'DOL', fredSeriesId: 'ICSA', frequency: 'weekly', time: '08:30 ET', table: 'econLabor1d' },
  { releaseId: 18, eventName: 'Interest Rates', eventType: 'rates', impactRating: 'low', source: 'Fed', fredSeriesId: 'DGS10', frequency: 'daily', time: '16:00 ET', table: 'econYields1d' },
]

interface FredReleaseDatesResponse {
  release_dates?: Array<{ date: string }>
}

function utcDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
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

async function loadSeriesActualMap(table: EconTable, seriesId: string, startDate: Date): Promise<Map<string, number>> {
  const where = { seriesId, eventDate: { gte: startDate } }

  const rows =
    table === 'econRates1d'
      ? await prisma.econRates1d.findMany({ where, select: { eventDate: true, value: true } })
      : table === 'econYields1d'
        ? await prisma.econYields1d.findMany({ where, select: { eventDate: true, value: true } })
        : table === 'econInflation1d'
          ? await prisma.econInflation1d.findMany({ where, select: { eventDate: true, value: true } })
          : table === 'econLabor1d'
            ? await prisma.econLabor1d.findMany({ where, select: { eventDate: true, value: true } })
            : table === 'econActivity1d'
              ? await prisma.econActivity1d.findMany({ where, select: { eventDate: true, value: true } })
              : table === 'econMoney1d'
                ? await prisma.econMoney1d.findMany({ where, select: { eventDate: true, value: true } })
                : await prisma.econVolIndices1d.findMany({ where, select: { eventDate: true, value: true } })

  const out = new Map<string, number>()
  for (const row of rows) {
    out.set(toDateKey(row.eventDate), toNum(row.value))
  }
  return out
}

export async function GET(request: Request) {
  try {
    const apiKey = process.env.FRED_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'FRED_API_KEY is required' }, { status: 500 })
    }

    const url = new URL(request.url)
    const startDateStr = url.searchParams.get('start') || '2020-01-01'
    const startDate = utcDateOnly(startDateStr)

    const actualMaps = new Map<string, Map<string, number>>()
    for (const spec of RELEASE_SPECS) {
      if (!actualMaps.has(spec.fredSeriesId)) {
        actualMaps.set(spec.fredSeriesId, await loadSeriesActualMap(spec.table, spec.fredSeriesId, startDate))
      }
    }

    let processed = 0
    let inserted = 0
    let updated = 0

    for (const spec of RELEASE_SPECS) {
      const dates = await fetchReleaseDates(spec.releaseId, apiKey, startDateStr)
      const actualMap = actualMaps.get(spec.fredSeriesId) || new Map<string, number>()

      for (const dateStr of dates) {
        const eventDate = utcDateOnly(dateStr)
        const actual = actualMap.get(dateStr)
        const existing = await prisma.econCalendar.findUnique({
          where: {
            eventDate_eventName: {
              eventDate,
              eventName: spec.eventName,
            },
          },
          select: { id: true },
        })

        await prisma.econCalendar.upsert({
          where: {
            eventDate_eventName: {
              eventDate,
              eventName: spec.eventName,
            },
          },
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

      // Keep comfortably under 120 req/min even if route expands later.
      await sleep(550)
    }

    return NextResponse.json({
      ok: true,
      startDate: startDateStr,
      releases: RELEASE_SPECS.length,
      processed,
      inserted,
      updated,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
