import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required')
  }

  const [
    symbols,
    symbolMappings,
    futures1h,
    legacyBars,
    econRates,
    econYields,
    econFx,
    econVol,
    mktIndexes,
    mktSpot,
    policyNews,
    macroReports,
    econSeries,
    econObs,
    macro,
    mm,
    runs,
    dataSources,
  ] =
    await Promise.all([
      prisma.symbol.count(),
      prisma.symbolMapping.count(),
      prisma.mktFutures1h.count(),
      prisma.marketBar.count(),
      prisma.econRates1d.count(),
      prisma.econYields1d.count(),
      prisma.econFx1d.count(),
      prisma.econVolIndices1d.count(),
      prisma.mktIndexes1d.count(),
      prisma.mktSpot1d.count(),
      prisma.policyNews1d.count(),
      prisma.macroReport1d.count(),
      prisma.economicSeries.count(),
      prisma.economicObservation.count(),
      prisma.macroIndicator.count(),
      prisma.measuredMoveSignal.count(),
      prisma.ingestionRun.count(),
      prisma.dataSourceRegistry.count(),
    ])

  console.log('\n=== Table Counts ===')
  console.table([
    { table: 'symbols', rows: symbols },
    { table: 'symbol_mappings', rows: symbolMappings },
    { table: 'mkt_futures_1h', rows: futures1h },
    { table: 'market_bars (legacy)', rows: legacyBars },
    { table: 'econ_rates_1d', rows: econRates },
    { table: 'econ_yields_1d', rows: econYields },
    { table: 'econ_fx_1d', rows: econFx },
    { table: 'econ_vol_indices_1d', rows: econVol },
    { table: 'mkt_indexes_1d', rows: mktIndexes },
    { table: 'mkt_spot_1d', rows: mktSpot },
    { table: 'policy_news_1d', rows: policyNews },
    { table: 'macro_reports_1d', rows: macroReports },
    { table: 'economic_series', rows: econSeries },
    { table: 'economic_observations_1d (legacy)', rows: econObs },
    { table: 'macro_indicators (legacy)', rows: macro },
    { table: 'measured_move_signals', rows: mm },
    { table: 'ingestion_runs', rows: runs },
    { table: 'data_source_registry', rows: dataSources },
  ])

  const futuresGrouped = await prisma.mktFutures1h.groupBy({
    by: ['symbolCode'],
    _count: { _all: true },
    orderBy: [{ symbolCode: 'asc' }],
  })

  console.log('\n=== Futures 1H by Symbol ===')
  console.table(
    futuresGrouped.map((row: { symbolCode: string; _count: { _all: number } }) => ({
      symbol: row.symbolCode,
      rows: row._count._all,
    }))
  )

  const [ratesGrouped, yieldsGrouped, fxGrouped, volGrouped, indexGrouped] = await Promise.all([
    prisma.econRates1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econYields1d.groupBy({
      by: ['seriesId'],
      _count: { _all: true },
      orderBy: { seriesId: 'asc' },
    }),
    prisma.econFx1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econVolIndices1d.groupBy({
      by: ['seriesId'],
      _count: { _all: true },
      orderBy: { seriesId: 'asc' },
    }),
    prisma.mktIndexes1d.groupBy({ by: ['symbol'], _count: { _all: true }, orderBy: { symbol: 'asc' } }),
  ])

  console.log('\n=== Domain Series Coverage ===')
  console.table(
    [
      ...ratesGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
        domain: 'RATES',
        key: row.seriesId,
        rows: row._count._all,
      })),
      ...yieldsGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
        domain: 'YIELDS',
        key: row.seriesId,
        rows: row._count._all,
      })),
      ...fxGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
        domain: 'FX',
        key: row.seriesId,
        rows: row._count._all,
      })),
      ...volGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
        domain: 'VOL_INDICES',
        key: row.seriesId,
        rows: row._count._all,
      })),
      ...indexGrouped.map((row: { symbol: string; _count: { _all: number } }) => ({
        domain: 'INDEXES',
        key: row.symbol,
        rows: row._count._all,
      })),
    ]
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
