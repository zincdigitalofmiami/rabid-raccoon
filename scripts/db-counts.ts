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
    mesPrices1m,
    mesPrices1h,
    futuresExMes1h,
    mesLeakInNonMes,
    econRates,
    econYields,
    econFx,
    econVol,
    econInflation,
    econLabor,
    econActivity,
    econMoney,
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
    prisma.mesPrice1m.count(),
    prisma.mesPrice1h.count(),
    prisma.futuresExMes1h.count(),
    prisma.futuresExMes1h.count({ where: { symbolCode: 'MES' } }),
    prisma.econRates1d.count(),
    prisma.econYields1d.count(),
    prisma.econFx1d.count(),
    prisma.econVolIndices1d.count(),
    prisma.econInflation1d.count(),
    prisma.econLabor1d.count(),
    prisma.econActivity1d.count(),
    prisma.econMoney1d.count(),
    prisma.econCommodities1d.count(),
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
    { table: 'mes_prices_1m', rows: mesPrices1m },
    { table: 'mes_prices_1h', rows: mesPrices1h },
    { table: 'futures_ex_mes_1h', rows: futuresExMes1h },
    { table: 'mes_leak_check_in_futures_ex_mes_1h', rows: mesLeakInNonMes },
    { table: 'econ_rates_1d', rows: econRates },
    { table: 'econ_yields_1d', rows: econYields },
    { table: 'econ_fx_1d', rows: econFx },
    { table: 'econ_vol_indices_1d', rows: econVol },
    { table: 'econ_inflation_1d', rows: econInflation },
    { table: 'econ_labor_1d', rows: econLabor },
    { table: 'econ_activity_1d', rows: econActivity },
    { table: 'econ_money_1d', rows: econMoney },
    { table: 'econ_commodities_1d', rows: econCommodities },
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

  const [nonMesGrouped, ratesGrouped, yieldsGrouped, fxGrouped, volGrouped, inflationGrouped, laborGrouped, activityGrouped, moneyGrouped, commoditiesGrouped, indexGrouped] =
    await Promise.all([
      prisma.futuresExMes1h.groupBy({
        by: ['symbolCode'],
        _count: { _all: true },
        orderBy: [{ symbolCode: 'asc' }],
      }),
      prisma.econRates1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econYields1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econFx1d.groupBy({ by: ['seriesId'], _count: { _all: true }, orderBy: { seriesId: 'asc' } }),
      prisma.econVolIndices1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econInflation1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econLabor1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econActivity1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econMoney1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.econCommodities1d.groupBy({
        by: ['seriesId'],
        _count: { _all: true },
        orderBy: { seriesId: 'asc' },
      }),
      prisma.mktIndexes1d.groupBy({ by: ['symbol'], _count: { _all: true }, orderBy: { symbol: 'asc' } }),
    ])

  console.log('\n=== Futures 1H Coverage (Non-MES) ===')
  console.table(
    nonMesGrouped.map((row: { symbolCode: string; _count: { _all: number } }) => ({
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
    ...indexGrouped.map((row: { symbol: string; _count: { _all: number } }) => ({
      domain: 'INDEXES',
      key: row.symbol,
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
