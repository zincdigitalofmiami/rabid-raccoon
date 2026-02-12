import { Timeframe } from '@prisma/client'
import { fetchOhlcv, toCandles, getCurrentSessionTimes } from './databento'
import {
  fetchVixCandles,
  fetchTenYearYieldCandles,
  getFredDateRange,
} from './fred'
import { prisma } from './prisma'
import { SYMBOLS } from './symbols'
import { CandleData } from './types'

const DB_TF_PRIORITY: Timeframe[] = [
  Timeframe.M1,
  Timeframe.M5,
  Timeframe.M15,
  Timeframe.H1,
  Timeframe.H4,
  Timeframe.D1,
]

async function fetchCandlesFromDb(symbol: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!process.env.DATABASE_URL) return null

  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null

  try {
    for (const timeframe of DB_TF_PRIORITY) {
      const bars = await prisma.marketBar.findMany({
        where: {
          symbolCode: symbol,
          timeframe,
          timestamp: {
            gte: start,
            lte: end,
          },
        },
        orderBy: { timestamp: 'asc' },
        take: 20_000,
      })

      if (bars.length === 0) continue
      return bars.map((bar) => ({
        time: Math.floor(bar.timestamp.getTime() / 1000),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ? Number(bar.volume) : 0,
      }))
    }
  } catch {
    return null
  }

  return null
}

async function fetchMacroFromDb(indicator: string, startIso: string, endIso: string): Promise<CandleData[] | null> {
  if (!process.env.DATABASE_URL) return null
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null

  try {
    const rows = await prisma.macroIndicator.findMany({
      where: {
        indicator,
        timestamp: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { timestamp: 'asc' },
      take: 10_000,
    })
    if (rows.length === 0) return null

    return rows.map((row) => ({
      time: Math.floor(row.timestamp.getTime() / 1000),
      open: row.value,
      high: row.value,
      low: row.value,
      close: row.value,
      volume: 0,
    }))
  } catch {
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
