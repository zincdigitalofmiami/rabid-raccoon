import { prisma } from './prisma'
import { SYMBOLS } from './symbols'
import { CandleData } from './types'
import { toNum } from './decimal'

type DbState = 'disabled' | 'probing' | 'enabled' | 'failed'

let dbState: DbState = process.env.DATABASE_URL ? 'probing' : 'disabled'
let dbProbePromise: Promise<boolean> | null = null

async function canUseDatabase(): Promise<boolean> {
  if (dbState === 'disabled' || dbState === 'failed') return false
  if (dbState === 'enabled') return true

  if (!dbProbePromise) {
    dbProbePromise = (async () => {
      try {
        await prisma.$queryRawUnsafe('SELECT 1')
        dbState = 'enabled'
        return true
      } catch {
        dbState = 'failed'
        return false
      } finally {
        dbProbePromise = null
      }
    })()
  }

  return dbProbePromise
}

function defaultSessionWindow(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getTime() - 18 * 60 * 60 * 1000)
  return {
    start: start.toISOString(),
    end: now.toISOString(),
  }
}

function defaultDailyWindow(lookbackDays = 180): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  return {
    start: start.toISOString(),
    end: now.toISOString(),
  }
}

function parseDateRange(startIso: string, endIso: string): { start: Date; end: Date } | null {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null
  return { start, end }
}

function toCandle(timeMs: number, open: number, high: number, low: number, close: number, volume = 0): CandleData {
  return {
    time: Math.floor(timeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const INDEX_PROXY_BY_SYMBOL: Record<string, string> = {
  ZN: 'IEF',
  ZB: 'TLT',
  GC: 'GLD',
  CL: 'USO',
}

function fredIndicatorForSymbol(symbol: string): string | null {
  if (symbol === 'VX') return 'VIXCLS'
  if (symbol === 'US10Y') return 'DGS10'
  if (symbol === 'DX' || symbol === 'DXY') return 'DTWEXBGS'
  return null
}

function defaultWindowForSymbol(symbol: string): { start: string; end: string } {
  if (symbol === 'MES') return defaultSessionWindow()
  return defaultDailyWindow()
}

async function fetchCandlesFromDb(symbol: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!(await canUseDatabase())) return null

  const parsed = parseDateRange(startIso, endIso)
  if (!parsed) return null

  const { start, end } = parsed

  try {
    if (symbol === 'MES') {
      const rows15m = await prisma.mktFuturesMes15m.findMany({
        where: {
          eventTime: {
            gte: start,
            lte: end,
          },
        },
        orderBy: { eventTime: 'asc' },
        take: 20_000,
      })
      if (rows15m.length > 0) {
        return rows15m.map((row) =>
          toCandle(row.eventTime.getTime(), toNum(row.open), toNum(row.high), toNum(row.low), toNum(row.close), row.volume ? Number(row.volume) : 0)
        )
      }

      const rows1h = await prisma.mktFuturesMes1h.findMany({
        where: {
          eventTime: {
            gte: start,
            lte: end,
          },
        },
        orderBy: { eventTime: 'asc' },
        take: 20_000,
      })
      if (rows1h.length === 0) return null
      return rows1h.map((row) =>
        toCandle(row.eventTime.getTime(), toNum(row.open), toNum(row.high), toNum(row.low), toNum(row.close), row.volume ? Number(row.volume) : 0)
      )
    }

    const rows = await prisma.mktFutures1d.findMany({
      where: {
        symbolCode: symbol,
        eventDate: {
          gte: startOfUtcDay(start),
          lte: startOfUtcDay(end),
        },
      },
      orderBy: { eventDate: 'asc' },
      take: 20_000,
    })

    if (rows.length > 0) {
      return rows.map((row) =>
        toCandle(
          row.eventDate.getTime(),
          toNum(row.open),
          toNum(row.high),
          toNum(row.low),
          toNum(row.close),
          row.volume ? Number(row.volume) : 0
        )
      )
    }

    const proxy = INDEX_PROXY_BY_SYMBOL[symbol]
    if (!proxy) return null

    const proxyRows = await prisma.mktIndexes1d.findMany({
      where: {
        symbolCode: proxy,
        eventDate: {
          gte: startOfUtcDay(start),
          lte: startOfUtcDay(end),
        },
      },
      orderBy: { eventDate: 'asc' },
      take: 20_000,
    })

    if (proxyRows.length === 0) return null
    return proxyRows.map((row) =>
      toCandle(
        row.eventDate.getTime(),
        toNum(row.open ?? row.close ?? 0),
        toNum(row.high ?? row.close ?? 0),
        toNum(row.low ?? row.close ?? 0),
        toNum(row.close ?? 0),
        row.volume ? Number(row.volume) : 0
      )
    )
  } catch {
    dbState = 'failed'
    return null
  }
}

async function fetchMacroFromDb(indicator: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!(await canUseDatabase())) return null
  const parsed = parseDateRange(startIso, endIso)
  if (!parsed) return null

  const { start, end } = parsed

  try {
    if (indicator === 'VIXCLS') {
      const rows = await prisma.econVolIndices1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length === 0) return null
      const val = (row: typeof rows[0]) => toNum(row.value ?? 0)
      return rows.map((row) => toCandle(row.eventDate.getTime(), val(row), val(row), val(row), val(row), 0))
    }

    if (indicator === 'DGS10') {
      const rows = await prisma.econYields1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length === 0) return null
      const val = (row: typeof rows[0]) => toNum(row.value ?? 0)
      return rows.map((row) => toCandle(row.eventDate.getTime(), val(row), val(row), val(row), val(row), 0))
    }

    if (indicator === 'DFF') {
      const rows = await prisma.econRates1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length === 0) return null
      const val = (row: typeof rows[0]) => toNum(row.value ?? 0)
      return rows.map((row) => toCandle(row.eventDate.getTime(), val(row), val(row), val(row), val(row), 0))
    }

    if (indicator === 'DTWEXBGS') {
      const rows = await prisma.econFx1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: startOfUtcDay(start), lte: startOfUtcDay(end) } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length === 0) return null
      const val = (row: typeof rows[0]) => toNum(row.value ?? 0)
      return rows.map((row) => toCandle(row.eventDate.getTime(), val(row), val(row), val(row), val(row), 0))
    }

    return null
  } catch {
    dbState = 'failed'
    return null
  }
}

function aggregateToDaily(candles: CandleData[]): CandleData[] {
  if (candles.length === 0) return []

  const byDay = new Map<number, CandleData>()

  for (const candle of candles) {
    const dt = new Date(candle.time * 1000)
    const dayUtc = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
    const current = byDay.get(dayUtc)
    if (!current) {
      byDay.set(dayUtc, {
        time: Math.floor(dayUtc / 1000),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      })
      continue
    }

    current.high = Math.max(current.high, candle.high)
    current.low = Math.min(current.low, candle.low)
    current.close = candle.close
    current.volume = (current.volume || 0) + (candle.volume || 0)
  }

  return [...byDay.values()].sort((a, b) => a.time - b.time)
}

function databaseOnlyError(symbol: string): never {
  throw new Error(
    `No DB data available for ${symbol}. Runtime provider fallbacks are disabled. ` +
      'Run machine ingestion first: npm run ingest:market && npm run ingest:macro && npm run ingest:mm'
  )
}

export async function fetchCandlesForSymbol(
  symbol: string,
  start?: string,
  end?: string
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  const defaults = defaultWindowForSymbol(symbol)
  const queryStart = start || defaults.start
  const queryEnd = end || defaults.end

  const indicator = config.dataSource === 'fred' ? fredIndicatorForSymbol(symbol) : null
  if (indicator) {
    const candles = await fetchMacroFromDb(indicator, queryStart, queryEnd)
    if (!candles || candles.length === 0) databaseOnlyError(symbol)
    return candles
  }

  if (symbol === 'DX' || symbol === 'DXY') {
    const dxCandles = await fetchMacroFromDb('DTWEXBGS', queryStart, queryEnd)
    if (dxCandles && dxCandles.length > 0) return dxCandles
  }

  const candles = await fetchCandlesFromDb(symbol, queryStart, queryEnd)
  if (!candles || candles.length === 0) databaseOnlyError(symbol)
  return candles
}

export async function fetchDailyCandlesForSymbol(
  symbol: string,
  lookbackDays: number = 90
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  const end = new Date()
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  const queryStart = start.toISOString()
  const queryEnd = end.toISOString()

  const indicator = config.dataSource === 'fred' ? fredIndicatorForSymbol(symbol) : null
  if (indicator) {
    const candles = await fetchMacroFromDb(indicator, queryStart, queryEnd)
    if (!candles || candles.length === 0) databaseOnlyError(symbol)
    return candles
  }

  if (symbol === 'DX' || symbol === 'DXY') {
    const dxCandles = await fetchMacroFromDb('DTWEXBGS', queryStart, queryEnd)
    if (dxCandles && dxCandles.length > 0) return dxCandles
  }

  const hourly = await fetchCandlesFromDb(symbol, queryStart, queryEnd)
  if (!hourly || hourly.length === 0) databaseOnlyError(symbol)
  if (symbol !== 'MES') return hourly

  const daily = aggregateToDaily(hourly)
  if (daily.length === 0) databaseOnlyError(symbol)
  return daily
}
