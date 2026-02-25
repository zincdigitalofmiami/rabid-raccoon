import { Prisma, SignalDirection, SignalStatus } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { detectMeasuredMoves } from '../src/lib/measured-move'
import { detectSwings } from '../src/lib/swing-detection'
import { toNum } from '../src/lib/decimal'
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

interface MmIngestOptions {
  daysBack?: number
  timeframe?: string
  dryRun?: boolean
  symbols?: string[]
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

function dbRowToCandle(row: { eventTime: Date; open: Parameters<typeof toNum>[0]; high: Parameters<typeof toNum>[0]; low: Parameters<typeof toNum>[0]; close: Parameters<typeof toNum>[0]; volume: bigint | null }): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume ? Number(row.volume) : 0,
  }
}

async function loadMesCandles(start: Date): Promise<CandleData[]> {
  const rows = await prisma.mktFuturesMes1h.findMany({
    where: { eventTime: { gte: start } },
    orderBy: { eventTime: 'asc' },
    select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
  })
  return rows.map(dbRowToCandle)
}

async function loadNonMesCandles(symbolCodes: string[], start: Date): Promise<Map<string, CandleData[]>> {
  const perSymbol = new Map<string, CandleData[]>()
  if (symbolCodes.length === 0) return perSymbol

  const rows = await prisma.mktFutures1h.findMany({
    where: { eventTime: { gte: start }, symbolCode: { in: symbolCodes } },
    orderBy: [{ symbolCode: 'asc' }, { eventTime: 'asc' }],
    select: { symbolCode: true, eventTime: true, open: true, high: true, low: true, close: true, volume: true },
  })

  for (const row of rows) {
    const list = perSymbol.get(row.symbolCode) || []
    list.push(dbRowToCandle(row))
    perSymbol.set(row.symbolCode, list)
  }
  return perSymbol
}

function buildSignalRow(
  symbolCode: string,
  tfPrisma: ReturnType<typeof timeframeToPrisma>,
  move: ReturnType<typeof detectMeasuredMoves>[number]
): Prisma.MeasuredMoveSignalCreateManyInput {
  const impulse = Math.abs(move.pointB.price - move.pointA.price)
  const target1236 = move.direction === 'BULLISH'
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
}

interface SymbolSignalResult {
  processed: number
  inserted: number
  error?: string
}

async function processSymbolSignals(
  symbolCode: string,
  candles: CandleData[],
  tfPrisma: ReturnType<typeof timeframeToPrisma>,
  dryRun: boolean
): Promise<SymbolSignalResult> {
  if (candles.length < 30) {
    return { processed: 0, inserted: 0, error: `Not enough candles (${candles.length})` }
  }

  const { highs, lows } = detectSwings(candles)
  const currentPrice = candles[candles.length - 1].close
  const moves = detectMeasuredMoves(highs, lows, currentPrice)
  const rows = moves.map((move) => buildSignalRow(symbolCode, tfPrisma, move))

  if (dryRun || rows.length === 0) {
    return { processed: rows.length, inserted: 0 }
  }

  const inserted = await prisma.measuredMoveSignal.createMany({
    data: rows,
    skipDuplicates: true,
  })
  return { processed: rows.length, inserted: inserted.count }
}

interface ResolvedMmOptions {
  daysBack: number
  timeframe: string
  dryRun: boolean
  symbolsRequested: string[]
}

function resolveMmOptions(options?: MmIngestOptions): ResolvedMmOptions {
  const daysBack = Number.isFinite(options?.daysBack)
    ? Number(options?.daysBack)
    : Number(parseArg('days-back', '120'))
  const timeframe = parseTimeframe(options?.timeframe ?? parseArg('timeframe', '1h'))
  const dryRun = options?.dryRun ?? parseArg('dry-run', 'false').toLowerCase() === 'true'
  const rawSymbols = options?.symbols?.length ? options.symbols.join(',') : parseArg('symbols', '')
  const symbolsRequested = rawSymbols
    ? rawSymbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : ['MES']
  return { daysBack, timeframe, dryRun, symbolsRequested }
}

async function loadAllCandles(symbolsRequested: string[], start: Date): Promise<Map<string, CandleData[]>> {
  const perSymbol = new Map<string, CandleData[]>()

  if (symbolsRequested.includes('MES')) {
    const mesCandles = await loadMesCandles(start)
    if (mesCandles.length > 0) perSymbol.set('MES', mesCandles)
  }

  const nonMesRequested = symbolsRequested.filter((code) => code !== 'MES')
  const nonMesMap = await loadNonMesCandles(nonMesRequested, start)
  for (const [code, candles] of nonMesMap) {
    perSymbol.set(code, candles)
  }

  return perSymbol
}

function finalizeRunUpdate(
  runId: bigint,
  status: 'COMPLETED' | 'FAILED',
  rowsProcessed: number,
  rowsInserted: number,
  rowsFailed: number,
  details: Prisma.InputJsonValue
) {
  return prisma.ingestionRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), rowsProcessed, rowsInserted, rowsFailed, details },
  })
}

export async function runIngestMeasuredMoveSignals(options?: MmIngestOptions): Promise<MmIngestSummary> {
  loadDotEnvFiles()

  const { daysBack, timeframe, dryRun, symbolsRequested } = resolveMmOptions(options)

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!Number.isFinite(daysBack) || daysBack <= 0) {
    throw new Error(`Invalid --days-back '${daysBack}'`)
  }
  if (timeframe !== '1h') {
    throw new Error(`Unsupported timeframe=${timeframe}. MM ingestion currently runs on 1h only.`)
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
    const perSymbol = await loadAllCandles(symbolsRequested, start)
    if (perSymbol.size === 0) {
      throw new Error('No 1h market prices found. Ingest prices before MM signals.')
    }

    for (const [symbolCode, candles] of perSymbol.entries()) {
      try {
        const result = await processSymbolSignals(symbolCode, candles, tfPrisma, dryRun)
        if (result.error) {
          symbolsFailed[symbolCode] = result.error
          continue
        }
        rowsProcessed += result.processed
        rowsInserted += result.inserted
        symbolsProcessed.push(symbolCode)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbolCode] = message.slice(0, 400)
      }
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'COMPLETED' : 'FAILED'
    const summary: MmIngestSummary = {
      timeframe, daysBack, symbolsRequested, symbolsProcessed,
      symbolsFailed, rowsInserted, rowsProcessed, dryRun,
    }

    await finalizeRunUpdate(run.id, status, rowsProcessed, rowsInserted,
      Object.keys(symbolsFailed).length, toJson(summary))

    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalizeRunUpdate(run.id, 'FAILED', rowsProcessed, rowsInserted,
      Object.keys(symbolsFailed).length + 1, toJson({ error: message, symbolsFailed }))
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
