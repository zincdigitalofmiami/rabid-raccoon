import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()
  if (!process.env.LOCAL_DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL is required (or set PRISMA_DIRECT=1 with DIRECT_URL for explicit direct runs)')
  }

  const [
    symbols,
    symbolMappings,
    mesPrices15m,
    mesPrices1h,
    mesPrices1d,
    mktFutures1h,
    mktFutures1d,
    mesLeakInNonMes,
    splitRates,
    splitYields,
    splitFx,
    splitVol,
    splitInflation,
    splitLabor,
    splitActivity,
    splitMoney,
    splitCommodities,
    econIndexes,
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
    prisma.mktFuturesMes15m.count(),
    prisma.mktFuturesMes1h.count(),
    prisma.mktFuturesMes1d.count(),
    prisma.mktFutures1h.count(),
    prisma.mktFutures1d.count(),
    prisma.mktFutures1h.count({ where: { symbolCode: 'MES' } }),
    prisma.econRates1d.count(),
    prisma.econYields1d.count(),
    prisma.econFx1d.count(),
    prisma.econVolIndices1d.count(),
    prisma.econInflation1d.count(),
    prisma.econLabor1d.count(),
    prisma.econActivity1d.count(),
    prisma.econMoney1d.count(),
    prisma.econCommodities1d.count(),
    prisma.econIndexes1d.count(),
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
    { table: 'mkt_futures_mes_15m', rows: mesPrices15m },
    { table: 'mkt_futures_mes_1h', rows: mesPrices1h },
    { table: 'mkt_futures_mes_1d', rows: mesPrices1d },
    { table: 'mkt_futures_1h', rows: mktFutures1h },
    { table: 'mkt_futures_1d', rows: mktFutures1d },
    { table: 'mes_leak_check_in_mkt_futures_1h', rows: mesLeakInNonMes },
    { table: 'econ_rates_1d', rows: splitRates },
    { table: 'econ_yields_1d', rows: splitYields },
    { table: 'econ_fx_1d', rows: splitFx },
    { table: 'econ_vol_indices_1d', rows: splitVol },
    { table: 'econ_inflation_1d', rows: splitInflation },
    { table: 'econ_labor_1d', rows: splitLabor },
    { table: 'econ_activity_1d', rows: splitActivity },
    { table: 'econ_money_1d', rows: splitMoney },
    { table: 'econ_commodities_1d', rows: splitCommodities },
    { table: 'econ_indexes_1d', rows: econIndexes },
    { table: 'econ_news_1d', rows: econNews },
    { table: 'policy_news_1d', rows: policyNews },
    { table: 'macro_reports_1d', rows: macroReports },
    { table: 'economic_series', rows: econSeries },
    { table: 'measured_move_signals', rows: measuredMoves },
    { table: 'ingestion_runs', rows: runs },
    { table: 'data_source_registry', rows: dataSources },
  ])

  const [
    nonMesGrouped1h,
    nonMesGrouped1d,
    ratesGrouped,
    yieldsGrouped,
    fxGrouped,
    volGrouped,
    inflationGrouped,
    laborGrouped,
    activityGrouped,
    moneyGrouped,
    commoditiesGrouped,
    indexGrouped,
  ] = await Promise.all([
    prisma.mktFutures1h.groupBy({ by: ['symbolCode'], _count: { _all: true }, orderBy: [{ symbolCode: 'asc' }] }),
    prisma.mktFutures1d.groupBy({ by: ['symbolCode'], _count: { _all: true }, orderBy: [{ symbolCode: 'asc' }] }),
    prisma.econRates1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econYields1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econFx1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econVolIndices1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econInflation1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econLabor1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econActivity1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econMoney1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econCommodities1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
    prisma.econIndexes1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
  ])

  console.log('\n=== Futures 1H Coverage ===')
  console.table(nonMesGrouped1h.map((row) => ({ symbol: row.symbolCode, rows: row._count._all })))

  console.log('\n=== Futures 1D Coverage ===')
  console.table(nonMesGrouped1d.map((row) => ({ symbol: row.symbolCode, rows: row._count._all })))

  console.log('\n=== Domain Series Coverage ===')
  console.table([
    ...ratesGrouped.map((row) => ({ domain: 'RATES', key: row.seriesId, rows: row._count._all })),
    ...yieldsGrouped.map((row) => ({ domain: 'YIELDS', key: row.seriesId, rows: row._count._all })),
    ...fxGrouped.map((row) => ({ domain: 'FX', key: row.seriesId, rows: row._count._all })),
    ...volGrouped.map((row) => ({ domain: 'VOL_INDICES', key: row.seriesId, rows: row._count._all })),
    ...inflationGrouped.map((row) => ({ domain: 'INFLATION', key: row.seriesId, rows: row._count._all })),
    ...laborGrouped.map((row) => ({ domain: 'LABOR', key: row.seriesId, rows: row._count._all })),
    ...activityGrouped.map((row) => ({ domain: 'ACTIVITY', key: row.seriesId, rows: row._count._all })),
    ...moneyGrouped.map((row) => ({ domain: 'MONEY', key: row.seriesId, rows: row._count._all })),
    ...commoditiesGrouped.map((row) => ({ domain: 'COMMODITIES', key: row.seriesId, rows: row._count._all })),
    ...indexGrouped.map((row) => ({ domain: 'INDEXES', key: row.seriesId, rows: row._count._all })),
  ])
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[db-counts] failed: ${message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
