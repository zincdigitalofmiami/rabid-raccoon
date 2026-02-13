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
    mesPrices15m,
    mesPrices1h,
    futuresExMes1h,
    futuresExMes1d,
    mesLeakInNonMes,
    econObservations,
    econRates,
    econMoney,
    econFx,
    econVol,
    econInflation,
    econLabor,
    econActivity,
    econCommodities,
    mktIndexes,
    mktSpot,
    econNews,
    policyNews,
    macroReports,
    econSeries,
    measuredMoves,
    runs,
    dataSources,
  ] = await Promise.all([
    prisma.symbol.count(),
    prisma.symbolMapping.count(),
    prisma.mesPrice15m.count(),
    prisma.mesPrice1h.count(),
    prisma.futuresExMes1h.count(),
    prisma.futuresExMes1d.count(),
    prisma.futuresExMes1h.count({ where: { symbolCode: 'MES' } }),
    prisma.econObservation1d.count(),
    prisma.econObservation1d.count({ where: { category: 'RATES' } }),
    prisma.econObservation1d.count({ where: { category: 'MONEY' } }),
    prisma.econObservation1d.count({ where: { category: 'FX' } }),
    prisma.econObservation1d.count({ where: { category: 'VOLATILITY' } }),
    prisma.econObservation1d.count({ where: { category: 'INFLATION' } }),
    prisma.econObservation1d.count({ where: { category: 'LABOR' } }),
    prisma.econObservation1d.count({ where: { category: 'ACTIVITY' } }),
    prisma.econObservation1d.count({ where: { category: 'COMMODITIES' } }),
    prisma.mktIndexes1d.count(),
    prisma.mktSpot1d.count(),
    prisma.econNews1d.count(),
    prisma.policyNews1d.count(),
    prisma.macroReport1d.count(),
    prisma.economicSeries.count(),
    prisma.measuredMoveSignal.count(),
    prisma.ingestionRun.count(),
    prisma.dataSourceRegistry.count(),
  ])

  console.log('\n=== Table Counts ===')
  console.table([
    { table: 'symbols', rows: symbols },
    { table: 'symbol_mappings', rows: symbolMappings },
    { table: 'mes_prices_15m', rows: mesPrices15m },
    { table: 'mes_prices_1h', rows: mesPrices1h },
    { table: 'futures_ex_mes_1h', rows: futuresExMes1h },
    { table: 'futures_ex_mes_1d', rows: futuresExMes1d },
    { table: 'mes_leak_check_in_futures_ex_mes_1h', rows: mesLeakInNonMes },
    { table: 'econ_observations_1d (all)', rows: econObservations },
    { table: 'econ_observations_1d (RATES)', rows: econRates },
    { table: 'econ_observations_1d (MONEY)', rows: econMoney },
    { table: 'econ_observations_1d (FX)', rows: econFx },
    { table: 'econ_observations_1d (VOLATILITY)', rows: econVol },
    { table: 'econ_observations_1d (INFLATION)', rows: econInflation },
    { table: 'econ_observations_1d (LABOR)', rows: econLabor },
    { table: 'econ_observations_1d (ACTIVITY)', rows: econActivity },
    { table: 'econ_observations_1d (COMMODITIES)', rows: econCommodities },
    { table: 'mkt_indexes_1d', rows: mktIndexes },
    { table: 'mkt_spot_1d', rows: mktSpot },
    { table: 'econ_news_1d', rows: econNews },
    { table: 'policy_news_1d', rows: policyNews },
    { table: 'macro_reports_1d', rows: macroReports },
    { table: 'economic_series', rows: econSeries },
    { table: 'measured_move_signals', rows: measuredMoves },
    { table: 'ingestion_runs', rows: runs },
    { table: 'data_source_registry', rows: dataSources },
  ])

  const [nonMesGrouped1h, nonMesGrouped1d, ratesGrouped, yieldsGrouped, fxGrouped, volGrouped, inflationGrouped, laborGrouped, activityGrouped, moneyGrouped, commoditiesGrouped, indexGrouped] =
    await Promise.all([
      prisma.futuresExMes1h.groupBy({
        by: ['symbolCode'],
        _count: { _all: true },
        orderBy: [{ symbolCode: 'asc' }],
      }),
      prisma.futuresExMes1d.groupBy({
        by: ['symbolCode'],
        _count: { _all: true },
        orderBy: [{ symbolCode: 'asc' }],
      }),
      prisma.econObservation1d.groupBy({ by: ['seriesId'], where: { category: 'RATES' }, _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econObservation1d.groupBy({ by: ['seriesId'], where: { category: 'MONEY' }, _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econObservation1d.groupBy({ by: ['seriesId'], where: { category: 'FX' }, _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'VOLATILITY' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'INFLATION' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'LABOR' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'ACTIVITY' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'MONEY' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econObservation1d.groupBy({
        by: ['seriesId'],
        where: { category: 'COMMODITIES' },
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.mktIndexes1d.groupBy({ by: ['symbolCode'], _count: { _all: true }, orderBy: { symbolCode: 'asc' } }),
    ])

  console.log('\n=== Futures 1H Coverage (Non-MES, should be empty) ===')
  console.table(
    nonMesGrouped1h.map((row: { symbolCode: string; _count: { _all: number } }) => ({
      symbol: row.symbolCode,
      rows: row._count._all,
    }))
  )

  console.log('\n=== Futures 1D Coverage (Non-MES) ===')
  console.table(
    nonMesGrouped1d.map((row: { symbolCode: string; _count: { _all: number } }) => ({
      symbol: row.symbolCode,
      rows: row._count._all,
    }))
  )

  console.log('\n=== Domain Series Coverage ===')
  console.table([
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
    ...inflationGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
      domain: 'INFLATION',
      key: row.seriesId,
      rows: row._count._all,
    })),
    ...laborGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
      domain: 'LABOR',
      key: row.seriesId,
      rows: row._count._all,
    })),
    ...activityGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
      domain: 'ACTIVITY',
      key: row.seriesId,
      rows: row._count._all,
    })),
    ...moneyGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
      domain: 'MONEY',
      key: row.seriesId,
      rows: row._count._all,
    })),
    ...commoditiesGrouped.map((row: { seriesId: string; _count: { _all: number } }) => ({
      domain: 'COMMODITIES',
      key: row.seriesId,
      rows: row._count._all,
    })),
    ...indexGrouped.map((row: { symbolCode: string; _count: { _all: number } }) => ({
      domain: 'INDEXES',
      key: row.symbolCode,
      rows: row._count._all,
    })),
  ])
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
