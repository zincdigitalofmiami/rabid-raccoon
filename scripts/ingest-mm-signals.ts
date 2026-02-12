import { Prisma, SignalDirection, SignalStatus } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { detectMeasuredMoves } from '../src/lib/measured-move'
import { detectSwings } from '../src/lib/swing-detection'
import { CandleData } from '../src/lib/types'
import { loadDotEnvFiles, parseArg, parseTimeframe, timeframeToPrisma } from './ingest-utils'

interface MmIngestSummary {
  timeframe: string
  daysBack: number
  symbolsRequested: string[]
  symbolsProcessed: string[]
  symbolsFailed: Record<string, string>
  rowsInserted: number
  rowsProcessed: number
  dryRun: boolean
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function statusToPrisma(status: string): SignalStatus {
  const map: Record<string, SignalStatus> = {
    FORMING: SignalStatus.FORMING,
    ACTIVE: SignalStatus.ACTIVE,
    TARGET_HIT: SignalStatus.TARGET_HIT,
    STOPPED_OUT: SignalStatus.STOPPED_OUT,
  }
  return map[status] || SignalStatus.FORMING
}

function directionToPrisma(direction: string): SignalDirection {
  return direction === 'BEARISH' ? SignalDirection.BEARISH : SignalDirection.BULLISH
}

export async function runIngestMeasuredMoveSignals(): Promise<MmIngestSummary> {
  loadDotEnvFiles()

  const daysBack = Number(parseArg('days-back', '120'))
  const rawTimeframe = parseArg('timeframe', '1h')
  const timeframe = parseTimeframe(rawTimeframe)
  const dryRun = parseArg('dry-run', 'false').toLowerCase() === 'true'
  const rawSymbols = parseArg('symbols', '')
  const symbolsRequested = rawSymbols
    ? rawSymbols
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : []

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!Number.isFinite(daysBack) || daysBack <= 0) {
    throw new Error(`Invalid --days-back '${daysBack}'`)
  }

  const tfPrisma = timeframeToPrisma(timeframe)
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'mm-signals',
      status: 'RUNNING',
      details: toJson({ daysBack, timeframe }),
    },
  })

  let rowsInserted = 0
  let rowsProcessed = 0
  const symbolsProcessed: string[] = []
  const symbolsFailed: Record<string, string> = {}

  try {
    const whereClause: Prisma.MarketBarWhereInput = {
      timeframe: tfPrisma,
      timestamp: { gte: start },
      ...(symbolsRequested.length ? { symbolCode: { in: symbolsRequested } } : {}),
    }

    const bars = await prisma.marketBar.findMany({
      where: whereClause,
      orderBy: [{ symbolCode: 'asc' }, { timestamp: 'asc' }],
    })
    if (bars.length === 0) {
      throw new Error(
        `No market bars found for timeframe=${timeframe}. Ingest market bars before MM signals.`
      )
    }

    const perSymbol = new Map<string, CandleData[]>()
    for (const bar of bars) {
      const list = perSymbol.get(bar.symbolCode) || []
      list.push({
        time: Math.floor(bar.timestamp.getTime() / 1000),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ? Number(bar.volume) : 0,
      })
      perSymbol.set(bar.symbolCode, list)
    }

    for (const [symbolCode, candles] of perSymbol.entries()) {
      try {
        if (candles.length < 30) {
          symbolsFailed[symbolCode] = `Not enough candles (${candles.length})`
          continue
        }

        const { highs, lows } = detectSwings(candles)
        const currentPrice = candles[candles.length - 1].close
        const moves = detectMeasuredMoves(highs, lows, currentPrice)

        const rows: Prisma.MeasuredMoveSignalCreateManyInput[] = moves.map((move) => {
          const impulse = Math.abs(move.pointB.price - move.pointA.price)
          const target1236 =
            move.direction === 'BULLISH'
              ? move.pointC.price + impulse * 1.236
              : move.pointC.price - impulse * 1.236
          return {
            symbolCode,
            timeframe: tfPrisma,
            timestamp: new Date(move.pointC.time * 1000),
            direction: directionToPrisma(move.direction),
            status: statusToPrisma(move.status),
            pointA: move.pointA.price,
            pointB: move.pointB.price,
            pointC: move.pointC.price,
            entry: move.entry,
            stop: move.stop,
            target100: move.target,
            target1236,
            retracementRatio: move.retracementRatio,
            quality: move.quality,
            source: 'halsey',
          }
        })

        rowsProcessed += rows.length
        if (!dryRun && rows.length > 0) {
          const inserted = await prisma.measuredMoveSignal.createMany({
            data: rows,
            skipDuplicates: true,
          })
          rowsInserted += inserted.count
        }
        symbolsProcessed.push(symbolCode)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbolCode] = message.slice(0, 400)
      }
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'SUCCEEDED' : 'PARTIAL'
    const summary: MmIngestSummary = {
      timeframe,
      daysBack,
      symbolsRequested,
      symbolsProcessed,
      symbolsFailed,
      rowsInserted,
      rowsProcessed,
      dryRun,
    }

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
        rowsFailed: Object.keys(symbolsFailed).length,
        details: toJson(summary),
      },
    })

    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
        rowsFailed: Object.keys(symbolsFailed).length + 1,
        details: toJson({
          error: message,
          symbolsFailed,
        }),
      },
    })
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestMeasuredMoveSignals()
    .then((summary) => {
      console.log('\n[mm-signals] done')
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mm-signals] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
