import { NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/client'
import { prisma } from '@/lib/prisma'
import { computeAlignmentScore } from '@/lib/correlation-filter'
import { toNum } from '@/lib/decimal'
import type { CorrelationAlignment } from '@/lib/correlation-filter'
import type { CandleData } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CorrelationCadence = 'intraday' | 'daily' | 'unavailable'

interface CorrelationMeta {
  cadence: CorrelationCadence
  lookbackBars: number
  observations: number
  availableSymbols: string[]
  missingSymbols: string[]
  reason: string | null
}

interface CorrelationResponse {
  bullish: CorrelationAlignment
  bearish: CorrelationAlignment
  meta: CorrelationMeta
  timestamp: string
}

const EXPECTED_SYMBOLS = ['MES', 'NQ', 'VX', 'DX'] as const
const INTRADAY_LOOKBACK = 240
const DAILY_LOOKBACK_DAYS = 180

function rowToCandle(row: {
  eventTime: Date
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

function valueToCandle(eventDate: Date, value: Decimal | number | null): CandleData | null {
  if (value === null || value === undefined) return null
  const numValue = toNum(value)
  if (!Number.isFinite(numValue)) return null
  return {
    time: Math.floor(eventDate.getTime() / 1000),
    open: numValue,
    high: numValue,
    low: numValue,
    close: numValue,
    volume: 0,
  }
}

function buildNeutralAlignment(reason: string): CorrelationAlignment {
  return {
    vix: 0,
    dxy: 0,
    nq: 0,
    composite: 0,
    isAligned: false,
    details: reason,
  }
}

function observationCount(symbolCandles: Map<string, CandleData[]>): number {
  const counts = [...symbolCandles.values()].map((candles) => Math.max(0, candles.length - 1))
  if (counts.length === 0) return 0
  return Math.min(...counts)
}

function missingSymbols(symbolCandles: Map<string, CandleData[]>): string[] {
  return EXPECTED_SYMBOLS.filter((sym) => !symbolCandles.has(sym))
}

async function loadIntradayMap(): Promise<Map<string, CandleData[]>> {
  const map = new Map<string, CandleData[]>()

  const [mesRows, nqRows] = await Promise.all([
    prisma.mktFuturesMes1h.findMany({
      orderBy: { eventTime: 'desc' },
      take: INTRADAY_LOOKBACK,
    }),
    prisma.mktFutures1h.findMany({
      where: { symbolCode: 'NQ' },
      orderBy: { eventTime: 'desc' },
      take: INTRADAY_LOOKBACK,
    }),
  ])

  if (mesRows.length >= 20) {
    map.set('MES', [...mesRows].reverse().map(rowToCandle))
  }
  if (nqRows.length >= 20) {
    map.set(
      'NQ',
      [...nqRows].reverse().map((r) => ({
        time: Math.floor(r.eventTime.getTime() / 1000),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: r.volume == null ? 0 : Number(r.volume),
      }))
    )
  }

  return map
}

async function loadDailyMap(): Promise<Map<string, CandleData[]>> {
  const map = new Map<string, CandleData[]>()
  const cutoffTs = Date.now() - DAILY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const cutoff = new Date(cutoffTs)
  const cutoffDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate()))

  const [mesRows1h, nqRows, vixRows, dxyRows] = await Promise.all([
    prisma.mktFuturesMes1h.findMany({
      where: { eventTime: { gte: cutoff } },
      orderBy: { eventTime: 'asc' },
      select: {
        eventTime: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
    }),
    prisma.mktFutures1d.findMany({
      where: { symbolCode: 'NQ', eventDate: { gte: cutoffDay } },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, open: true, high: true, low: true, close: true, volume: true },
    }),
    prisma.econVolIndices1d.findMany({
      where: { seriesId: 'VIXCLS', eventDate: { gte: cutoffDay } },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
    prisma.econFx1d.findMany({
      where: { seriesId: 'DTWEXBGS', eventDate: { gte: cutoffDay } },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
  ])

  if (mesRows1h.length > 0) {
    const byDay = new Map<string, CandleData>()
    for (const row of mesRows1h) {
      const dayKey = row.eventTime.toISOString().slice(0, 10)
      const existing = byDay.get(dayKey)
      if (!existing) {
        byDay.set(dayKey, {
          time: Math.floor(new Date(`${dayKey}T00:00:00Z`).getTime() / 1000),
          open: toNum(row.open),
          high: toNum(row.high),
          low: toNum(row.low),
          close: toNum(row.close),
          volume: row.volume == null ? 0 : Number(row.volume),
        })
      } else {
        existing.high = Math.max(existing.high, toNum(row.high))
        existing.low = Math.min(existing.low, toNum(row.low))
        existing.close = toNum(row.close)
        existing.volume = (existing.volume ?? 0) + (row.volume == null ? 0 : Number(row.volume))
      }
    }
    const mesDaily = [...byDay.values()].sort((a, b) => a.time - b.time)
    if (mesDaily.length >= 20) {
      map.set('MES', mesDaily)
    }
  }

  if (nqRows.length >= 20) {
    map.set(
      'NQ',
      nqRows.map((row) => ({
        time: Math.floor(row.eventDate.getTime() / 1000),
        open: toNum(row.open),
        high: toNum(row.high),
        low: toNum(row.low),
        close: toNum(row.close),
        volume: row.volume == null ? 0 : Number(row.volume),
      }))
    )
  }

  const vix = vixRows.map((row) => valueToCandle(row.eventDate, row.value)).filter((row): row is CandleData => row != null)
  if (vix.length >= 20) {
    map.set('VX', vix)
  }

  const dxy = dxyRows.map((row) => valueToCandle(row.eventDate, row.value)).filter((row): row is CandleData => row != null)
  if (dxy.length >= 20) {
    map.set('DX', dxy)
  }

  return map
}

function buildResponse(
  symbolCandles: Map<string, CandleData[]>,
  cadence: CorrelationCadence,
  lookbackBars: number,
  reason: string | null
): CorrelationResponse {
  const obs = observationCount(symbolCandles)
  const available = [...symbolCandles.keys()]
  const missing = missingSymbols(symbolCandles)
  const canScore = symbolCandles.has('MES') && symbolCandles.size > 1 && obs >= 5

  const bullish = canScore
    ? computeAlignmentScore(symbolCandles, 'BULLISH')
    : buildNeutralAlignment(reason || 'Correlation unavailable: not enough aligned observations.')

  const bearish = canScore
    ? computeAlignmentScore(symbolCandles, 'BEARISH')
    : buildNeutralAlignment(reason || 'Correlation unavailable: not enough aligned observations.')

  return {
    bullish,
    bearish,
    meta: {
      cadence,
      lookbackBars,
      observations: obs,
      availableSymbols: available,
      missingSymbols: missing,
      reason,
    },
    timestamp: new Date().toISOString(),
  }
}

export async function GET(): Promise<Response> {
  try {
    const intraday = await loadIntradayMap()
    const intradayUsable = intraday.has('MES') && intraday.size > 1 && observationCount(intraday) >= 5

    if (intradayUsable) {
      const response = buildResponse(intraday, 'intraday', INTRADAY_LOOKBACK, null)
      return NextResponse.json(response)
    }

    const daily = await loadDailyMap()
    const dailyUsable = daily.has('MES') && daily.size > 1 && observationCount(daily) >= 5
    if (dailyUsable) {
      const response = buildResponse(
        daily,
        'daily',
        DAILY_LOOKBACK_DAYS,
        intraday.size <= 1
          ? 'Intraday correlation unavailable; using daily-aligned proxies (NQ/VX/DX).'
          : 'Intraday correlation had insufficient aligned observations; using daily-aligned proxies.'
      )
      return NextResponse.json(response)
    }

    const response = buildResponse(
      new Map<string, CandleData[]>(),
      'unavailable',
      DAILY_LOOKBACK_DAYS,
      'No aligned MES correlation inputs are currently available.'
    )
    return NextResponse.json(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        bullish: buildNeutralAlignment(`Correlation error: ${message}`),
        bearish: buildNeutralAlignment(`Correlation error: ${message}`),
        meta: {
          cadence: 'unavailable',
          lookbackBars: DAILY_LOOKBACK_DAYS,
          observations: 0,
          availableSymbols: [],
          missingSymbols: [...EXPECTED_SYMBOLS],
          reason: message,
        },
        timestamp: new Date().toISOString(),
      } satisfies CorrelationResponse,
      { status: 500 }
    )
  }
}
