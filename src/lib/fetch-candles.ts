import { fetchOhlcv, toCandles, getCurrentSessionTimes } from './databento'
import {
  fetchVixCandles,
  fetchTenYearYieldCandles,
  getFredDateRange,
} from './fred'
import { prisma } from './prisma'
import { SYMBOLS } from './symbols'
import { CandleData } from './types'

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

async function fetchCandlesFromDb(symbol: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!(await canUseDatabase())) return null

  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null

  try {
    if (symbol === 'MES') {
      const mesRows = await prisma.mesPrice1h.findMany({
        where: {
          eventTime: {
            gte: start,
            lte: end,
          },
        },
        orderBy: { eventTime: 'asc' },
        take: 20_000,
      })

      if (mesRows.length === 0) return null
      return mesRows.map((row) => ({
        time: Math.floor(row.eventTime.getTime() / 1000),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume ? Number(row.volume) : 0,
      }))
    }

    const futuresRows = await prisma.futuresExMes1h.findMany({
      where: {
        symbolCode: symbol,
        eventTime: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { eventTime: 'asc' },
      take: 20_000,
    })

    if (futuresRows.length === 0) return null
    return futuresRows.map((row) => ({
      time: Math.floor(row.eventTime.getTime() / 1000),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume ? Number(row.volume) : 0,
    }))
  } catch {
    dbState = 'failed'
    return null
  }
}

async function fetchMacroFromDb(indicator: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!(await canUseDatabase())) return null
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null

  try {
    const mapRowsToCandles = <T extends { eventDate: Date; value: number | null }>(rows: T[]) =>
      rows.map((row) => ({
        time: Math.floor(row.eventDate.getTime() / 1000),
        open: row.value ?? 0,
        high: row.value ?? 0,
        low: row.value ?? 0,
        close: row.value ?? 0,
        volume: 0,
      }))

    if (indicator === 'VIXCLS') {
      const rows = await prisma.econVolIndices1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: start, lte: end } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length > 0) return mapRowsToCandles(rows)
    } else if (indicator === 'DGS10') {
      const rows = await prisma.econYields1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: start, lte: end } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length > 0) return mapRowsToCandles(rows)
    } else if (indicator === 'DFF') {
      const rows = await prisma.econRates1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: start, lte: end } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length > 0) return mapRowsToCandles(rows)
    } else if (indicator === 'DTWEXBGS') {
      const rows = await prisma.econFx1d.findMany({
        where: { seriesId: indicator, eventDate: { gte: start, lte: end } },
        orderBy: { eventDate: 'asc' },
        take: 10_000,
      })
      if (rows.length > 0) return mapRowsToCandles(rows)
    }

    return null
  } catch {
    dbState = 'failed'
    return null
  }
}

export async function fetchCandlesForSymbol(
  symbol: string,
  start?: string,
  end?: string
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    const fredStart = start?.slice(0, 10) || fredRange.start
    const fredEnd = end?.slice(0, 10) || fredRange.end
    const dbStartIso = `${fredStart}T00:00:00.000Z`
    const dbEndIso = `${fredEnd}T23:59:59.999Z`

    if (symbol === 'VX') {
      const dbCandles = await fetchMacroFromDb('VIXCLS', dbStartIso, dbEndIso)
      if (dbCandles && dbCandles.length > 0) return dbCandles
      return fetchVixCandles(fredStart, fredEnd)
    } else if (symbol === 'US10Y') {
      const dbCandles = await fetchMacroFromDb('DGS10', dbStartIso, dbEndIso)
      if (dbCandles && dbCandles.length > 0) return dbCandles
      return fetchTenYearYieldCandles(fredStart, fredEnd)
    }
    throw new Error(`Unknown FRED symbol: ${symbol}`)
  }

  // Databento source
  const session = getCurrentSessionTimes()
  const queryStart = start || session.start
  const queryEnd = end || session.end
  const dbCandles = await fetchCandlesFromDb(symbol, queryStart, queryEnd)
  if (dbCandles && dbCandles.length > 0) return dbCandles

  const records = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: queryStart,
    end: queryEnd,
  })

  return toCandles(records)
}

export async function fetchDailyCandlesForSymbol(
  symbol: string,
  lookbackDays: number = 90
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  if (config.dataSource === 'fred') {
    const now = new Date()
    const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    const startDate = start.toISOString().slice(0, 10)
    const endDate = now.toISOString().slice(0, 10)
    const dbStartIso = `${startDate}T00:00:00.000Z`
    const dbEndIso = `${endDate}T23:59:59.999Z`

    if (symbol === 'VX') {
      const dbCandles = await fetchMacroFromDb('VIXCLS', dbStartIso, dbEndIso)
      if (dbCandles && dbCandles.length > 0) return dbCandles
      return fetchVixCandles(startDate, endDate)
    }
    if (symbol === 'US10Y') {
      const dbCandles = await fetchMacroFromDb('DGS10', dbStartIso, dbEndIso)
      if (dbCandles && dbCandles.length > 0) return dbCandles
      return fetchTenYearYieldCandles(startDate, endDate)
    }
    throw new Error(`Unknown FRED symbol: ${symbol}`)
  }

  const now = new Date()
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  const records = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: start.toISOString(),
    end: now.toISOString(),
    schema: 'ohlcv-1d',
  })

  return toCandles(records)
}
