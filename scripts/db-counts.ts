import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required')
  }

  const [symbols, bars, macro, mm, runs] = await Promise.all([
    prisma.symbol.count(),
    prisma.marketBar.count(),
    prisma.macroIndicator.count(),
    prisma.measuredMoveSignal.count(),
    prisma.ingestionRun.count(),
  ])

  console.log('\n=== Table Counts ===')
  console.table([
    { table: 'symbols', rows: symbols },
    { table: 'market_bars', rows: bars },
    { table: 'macro_indicators', rows: macro },
    { table: 'measured_move_signals', rows: mm },
    { table: 'ingestion_runs', rows: runs },
  ])

  const grouped = await prisma.marketBar.groupBy({
    by: ['symbolCode', 'timeframe'],
    _count: { _all: true },
    orderBy: [{ symbolCode: 'asc' }, { timeframe: 'asc' }],
  })

  console.log('\n=== Market Bars by Symbol/TF ===')
  console.table(
    grouped.map((row) => ({
      symbol: row.symbolCode,
      timeframe: row.timeframe,
      rows: row._count._all,
    }))
  )
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[db-counts] failed: ${message}`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

