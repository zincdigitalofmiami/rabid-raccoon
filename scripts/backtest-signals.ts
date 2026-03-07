import { getScriptPrismaClient, disconnectScriptPrismaClient } from './script-db'
import { computeSignals } from '../src/lib/instant-analysis'
import { CandleData } from '../src/lib/types'
import { toNum } from '../src/lib/decimal'
import type { PrismaClient } from '@prisma/client'

interface TradeObservation {
  symbol: string
  confidence: number
  direction: 'BUY' | 'SELL'
  nextReturnPct: number
  strategyReturnPct: number
  hit: boolean
}

const INDEX_PROXY_BY_SYMBOL: Record<string, string> = {
  ZN: 'IEF',
  ZB: 'TLT',
  GC: 'GLD',
  CL: 'USO',
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function toCandle(
  timeMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 0,
): CandleData {
  return {
    time: Math.floor(timeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
  }
}

function fredIndicatorForSymbol(symbol: string): string | null {
  if (symbol === 'VX') return 'VIXCLS'
  if (symbol === 'US10Y') return 'DGS10'
  if (symbol === 'DX' || symbol === 'DXY') return 'DTWEXBGS'
  return null
}

async function fetchMesCandles(
  prisma: PrismaClient,
  start: Date,
  end: Date,
): Promise<CandleData[]> {
  const rows15m = await prisma.mktFuturesMes15m.findMany({
    where: {
      eventTime: { gte: start, lte: end },
    },
    orderBy: { eventTime: 'asc' },
    select: {
      eventTime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
    take: 20_000,
  })

  if (rows15m.length > 0) {
    return rows15m.map((row) =>
      toCandle(
        row.eventTime.getTime(),
        toNum(row.open),
        toNum(row.high),
        toNum(row.low),
        toNum(row.close),
        row.volume ? Number(row.volume) : 0,
      ),
    )
  }

  const rows1h = await prisma.mktFuturesMes1h.findMany({
    where: {
      eventTime: { gte: start, lte: end },
    },
    orderBy: { eventTime: 'asc' },
    select: {
      eventTime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
    take: 20_000,
  })

  return rows1h.map((row) =>
    toCandle(
      row.eventTime.getTime(),
      toNum(row.open),
      toNum(row.high),
      toNum(row.low),
      toNum(row.close),
      row.volume ? Number(row.volume) : 0,
    ),
  )
}

async function fetchMacroCandles(
  prisma: PrismaClient,
  indicator: string,
  start: Date,
  end: Date,
): Promise<CandleData[]> {
  const from = startOfUtcDay(start)
  const to = startOfUtcDay(end)

  if (indicator === 'VIXCLS') {
    const rows = await prisma.econVolIndices1d.findMany({
      where: { seriesId: indicator, eventDate: { gte: from, lte: to } },
      orderBy: { eventDate: 'asc' },
      take: 10_000,
    })
    return rows.map((row) => {
      const value = toNum(row.value ?? 0)
      return toCandle(row.eventDate.getTime(), value, value, value, value, 0)
    })
  }

  if (indicator === 'DGS10') {
    const rows = await prisma.econYields1d.findMany({
      where: { seriesId: indicator, eventDate: { gte: from, lte: to } },
      orderBy: { eventDate: 'asc' },
      take: 10_000,
    })
    return rows.map((row) => {
      const value = toNum(row.value ?? 0)
      return toCandle(row.eventDate.getTime(), value, value, value, value, 0)
    })
  }

  if (indicator === 'DTWEXBGS') {
    const rows = await prisma.econFx1d.findMany({
      where: { seriesId: indicator, eventDate: { gte: from, lte: to } },
      orderBy: { eventDate: 'asc' },
      take: 10_000,
    })
    return rows.map((row) => {
      const value = toNum(row.value ?? 0)
      return toCandle(row.eventDate.getTime(), value, value, value, value, 0)
    })
  }

  return []
}

async function fetchDailyFuturesCandles(
  prisma: PrismaClient,
  symbol: string,
  start: Date,
  end: Date,
): Promise<CandleData[]> {
  const rows = await prisma.mktFutures1d.findMany({
    where: {
      symbolCode: symbol,
      eventDate: {
        gte: startOfUtcDay(start),
        lte: startOfUtcDay(end),
      },
    },
    orderBy: { eventDate: 'asc' },
    select: {
      eventDate: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
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
        row.volume ? Number(row.volume) : 0,
      ),
    )
  }

  const proxy = INDEX_PROXY_BY_SYMBOL[symbol]
  if (!proxy) return []

  const proxyRows = await prisma.econIndexes1d.findMany({
    where: {
      seriesId: proxy,
      eventDate: {
        gte: startOfUtcDay(start),
        lte: startOfUtcDay(end),
      },
    },
    orderBy: { eventDate: 'asc' },
    select: {
      eventDate: true,
      value: true,
    },
    take: 20_000,
  })

  return proxyRows.map((row) => {
    const value = toNum(row.value ?? 0)
    return toCandle(row.eventDate.getTime(), value, value, value, value, 0)
  })
}

async function fetchCandlesForBacktest(
  prisma: PrismaClient,
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<CandleData[]> {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error(`Invalid backtest date range for ${symbol}`)
  }

  if (symbol === 'MES') {
    const candles = await fetchMesCandles(prisma, start, end)
    if (candles.length > 0) return candles
    throw new Error(`No DB data available for ${symbol} in requested range`)
  }

  const indicator = fredIndicatorForSymbol(symbol)
  if (indicator) {
    const candles = await fetchMacroCandles(prisma, indicator, start, end)
    if (candles.length > 0) return candles
    throw new Error(`No macro DB data available for ${symbol} (${indicator})`)
  }

  const candles = await fetchDailyFuturesCandles(prisma, symbol, start, end)
  if (candles.length > 0) return candles
  throw new Error(`No DB data available for ${symbol} in requested range`)
}

function aggregateCandles(candles: CandleData[], periodMinutes: number): CandleData[] {
  if (candles.length === 0) return []
  const periodSec = periodMinutes * 60
  const result: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const c of candles) {
    const aligned = Math.floor(c.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) result.push(bucket)
      bucket = {
        time: aligned,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      }
      bucketStart = aligned
    } else {
      bucket.high = Math.max(bucket.high, c.high)
      bucket.low = Math.min(bucket.low, c.low)
      bucket.close = c.close
      bucket.volume = (bucket.volume || 0) + (c.volume || 0)
    }
  }

  if (bucket) result.push(bucket)
  return result
}

function confidenceBucket(confidence: number): string {
  if (confidence >= 80) return '80-100'
  if (confidence >= 70) return '70-79'
  if (confidence >= 60) return '60-69'
  return '50-59'
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function pct(n: number): string {
  return `${n.toFixed(2)}%`
}

async function run(): Promise<void> {
  const prisma = getScriptPrismaClient()

  const symbols = (process.env.BACKTEST_SYMBOLS || 'MES,NQ,GC,CL')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  const lookbackDays = Number(process.env.BACKTEST_DAYS || 7)
  const warmupCandles = Number(process.env.BACKTEST_WARMUP_CANDLES || 220)
  const now = new Date()
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
  const end = now.toISOString()

  const observations: TradeObservation[] = []

  for (const symbol of symbols) {
    const candles = await fetchCandlesForBacktest(prisma, symbol, start, end)
    const candles15m = aggregateCandles(candles, 15)
    if (candles15m.length < warmupCandles + 2) {
      console.log(
        `[skip] ${symbol}: need at least ${warmupCandles + 2} aggregated candles, got ${candles15m.length}`
      )
      continue
    }

    for (let i = warmupCandles; i < candles15m.length - 1; i++) {
      const window = candles15m.slice(0, i + 1)
      const sig = computeSignals(window)
      const voting = sig.buy + sig.sell
      if (voting === 0) continue

      const direction: 'BUY' | 'SELL' = sig.buy >= sig.sell ? 'BUY' : 'SELL'
      const confidence = Math.round((Math.max(sig.buy, sig.sell) / voting) * 100)
      const entry = candles15m[i].close
      const next = candles15m[i + 1].close
      const nextReturnPct = entry > 0 ? ((next - entry) / entry) * 100 : 0
      const strategyReturnPct = direction === 'BUY' ? nextReturnPct : -nextReturnPct
      const hit = strategyReturnPct > 0

      observations.push({
        symbol,
        confidence,
        direction,
        nextReturnPct,
        strategyReturnPct,
        hit,
      })
    }
  }

  if (observations.length === 0) {
    console.log('No observations. Increase BACKTEST_DAYS or adjust symbols.')
    return
  }

  const total = observations.length
  const wins = observations.filter((o) => o.hit).length
  const hitRate = (wins / total) * 100
  const avgRawNext = mean(observations.map((o) => o.nextReturnPct))
  const avgStrategy = mean(observations.map((o) => o.strategyReturnPct))

  console.log('\n=== Deterministic Signal Backtest (next 15m candle) ===')
  console.log(`Symbols: ${symbols.join(', ')}`)
  console.log(`Window: last ${lookbackDays} day(s)`)
  console.log(`Samples: ${total}`)
  console.log(`Hit Rate: ${pct(hitRate)}`)
  console.log(`Avg next-candle move (raw): ${pct(avgRawNext)}`)
  console.log(`Avg next-candle move (strategy-signed): ${pct(avgStrategy)}`)

  const buckets = ['50-59', '60-69', '70-79', '80-100']
  const bucketRows = buckets.map((bucket) => {
    const rows = observations.filter((o) => confidenceBucket(o.confidence) === bucket)
    const bucketWins = rows.filter((o) => o.hit).length
    return {
      bucket,
      samples: rows.length,
      hitRate: rows.length > 0 ? pct((bucketWins / rows.length) * 100) : 'n/a',
      avgStrategy: rows.length > 0 ? pct(mean(rows.map((o) => o.strategyReturnPct))) : 'n/a',
    }
  })

  console.log('\nBy confidence bucket:')
  console.table(bucketRows)

  const symbolRows = [...new Set(observations.map((o) => o.symbol))]
    .map((symbol) => {
      const rows = observations.filter((o) => o.symbol === symbol)
      const symWins = rows.filter((o) => o.hit).length
      return {
        symbol,
        samples: rows.length,
        hitRate: pct((symWins / rows.length) * 100),
        avgStrategy: pct(mean(rows.map((o) => o.strategyReturnPct))),
      }
    })

  console.log('By symbol:')
  console.table(symbolRows)
}

run().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`Backtest failed: ${msg}`)
  process.exit(1)
}).finally(async () => {
  await disconnectScriptPrismaClient()
})
