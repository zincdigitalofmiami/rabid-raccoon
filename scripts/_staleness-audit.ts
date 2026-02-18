import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

interface TableSummary {
  table: string
  rows: number
  minDate: string
  maxDate: string
  daysStale: number
}

async function queryTable(
  table: string,
  dateCol: string,
  groupCol?: string
): Promise<void> {
  try {
    if (groupCol) {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ group: string; count: number; min_date: Date; max_date: Date }>
      >(
        `SELECT "${groupCol}" as "group", COUNT(*)::int as count, MIN("${dateCol}")::date as min_date, MAX("${dateCol}")::date as max_date FROM "${table}" GROUP BY "${groupCol}" ORDER BY max_date DESC`
      )
      console.log(`\n=== ${table} (grouped by ${groupCol}) ===`)
      if (rows.length === 0) {
        console.log('  (empty table)')
        return
      }
      console.table(
        rows.map((r) => ({
          [groupCol]: r.group,
          count: r.count,
          from: r.min_date?.toISOString().slice(0, 10) ?? 'N/A',
          to: r.max_date?.toISOString().slice(0, 10) ?? 'N/A',
          daysStale: r.max_date
            ? Math.floor(
                (Date.now() - new Date(r.max_date).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            : -1,
        }))
      )
    } else {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ count: number; min_date: Date; max_date: Date }>
      >(
        `SELECT COUNT(*)::int as count, MIN("${dateCol}")::date as min_date, MAX("${dateCol}")::date as max_date FROM "${table}"`
      )
      const r = rows[0]
      const daysStale = r?.max_date
        ? Math.floor(
            (Date.now() - new Date(r.max_date).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : -1
      console.log(`\n=== ${table} ===`)
      console.log(
        `  rows: ${r?.count ?? 0} | from: ${r?.min_date?.toISOString().slice(0, 10) ?? 'N/A'} | to: ${r?.max_date?.toISOString().slice(0, 10) ?? 'N/A'} | days stale: ${daysStale}`
      )
    }
  } catch (e: any) {
    console.log(`\n=== ${table} === ERROR: ${e.message?.slice(0, 120)}`)
  }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  DATA STALENESS AUDIT — ${new Date().toISOString().slice(0, 10)}`)
  console.log(`${'='.repeat(60)}`)

  // ── Market Data ──
  console.log('\n\n── MARKET DATA ──────────────────────────────')
  await queryTable('mkt_futures_mes_1h', 'eventTime')
  await queryTable('mkt_futures_mes_15m', 'eventTime')
  await queryTable('mkt_futures_mes_1d', 'eventDate')
  await queryTable('mkt_futures_1h', 'eventTime', 'symbolCode')
  await queryTable('mkt_futures_1d', 'eventDate', 'symbolCode')

  // ── FRED Economic ──
  console.log('\n\n── FRED ECONOMIC ────────────────────────────')
  const econTables = [
    'econ_rates_1d',
    'econ_yields_1d',
    'econ_fx_1d',
    'econ_vol_indices_1d',
    'econ_inflation_1d',
    'econ_labor_1d',
    'econ_activity_1d',
    'econ_money_1d',
    'econ_commodities_1d',
    'econ_indexes_1d',
  ]
  for (const t of econTables) {
    await queryTable(t, 'eventDate', 'seriesId')
  }

  // ── News / Calendar ──
  console.log('\n\n── NEWS / CALENDAR ──────────────────────────')
  await queryTable('econ_news_1d', 'eventDate')
  await queryTable('policy_news_1d', 'eventDate')
  await queryTable('macro_reports_1d', 'eventDate')
  await queryTable('econ_calendar', 'eventDate')
  await queryTable('news_signals', 'pubDate', 'layer')

  // ── Signals ──
  console.log('\n\n── SIGNALS ──────────────────────────────────')
  await queryTable('measured_move_signals', 'timestamp', 'symbolCode')
  await queryTable('bhg_setups', 'goTime', 'timeframe')

  // ── Ingestion Runs ──
  console.log('\n\n── INGESTION RUNS (last 10) ─────────────────')
  try {
    const runs = await prisma.$queryRawUnsafe<
      Array<{
        job: string
        status: string
        started: Date
        rows_inserted: number
      }>
    >(
      `SELECT job, status, "startedAt" as started, "rowsInserted" as rows_inserted FROM ingestion_runs ORDER BY "startedAt" DESC LIMIT 10`
    )
    console.table(
      runs.map((r) => ({
        job: r.job,
        status: r.status,
        started: r.started?.toISOString().slice(0, 16) ?? 'N/A',
        rowsInserted: r.rows_inserted,
      }))
    )
  } catch (e: any) {
    console.log(`  ERROR: ${e.message?.slice(0, 120)}`)
  }

  // ── Summary ──
  console.log('\n\n── SUMMARY ──────────────────────────────────')
  const summaryTables = [
    { table: 'mkt_futures_mes_1h', dateCol: 'eventTime' },
    { table: 'mkt_futures_mes_15m', dateCol: 'eventTime' },
    { table: 'mkt_futures_mes_1d', dateCol: 'eventDate' },
    { table: 'mkt_futures_1h', dateCol: 'eventTime' },
    { table: 'mkt_futures_1d', dateCol: 'eventDate' },
    ...econTables.map((t) => ({ table: t, dateCol: 'eventDate' })),
    { table: 'econ_news_1d', dateCol: 'eventDate' },
    { table: 'policy_news_1d', dateCol: 'eventDate' },
    { table: 'macro_reports_1d', dateCol: 'eventDate' },
    { table: 'econ_calendar', dateCol: 'eventDate' },
    { table: 'news_signals', dateCol: 'pubDate' },
    { table: 'measured_move_signals', dateCol: 'timestamp' },
    { table: 'bhg_setups', dateCol: 'goTime' },
  ]

  const summary: TableSummary[] = []
  for (const { table, dateCol } of summaryTables) {
    try {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ count: number; min_date: Date; max_date: Date }>
      >(
        `SELECT COUNT(*)::int as count, MIN("${dateCol}")::date as min_date, MAX("${dateCol}")::date as max_date FROM "${table}"`
      )
      const r = rows[0]
      summary.push({
        table,
        rows: r?.count ?? 0,
        minDate: r?.min_date?.toISOString().slice(0, 10) ?? 'N/A',
        maxDate: r?.max_date?.toISOString().slice(0, 10) ?? 'N/A',
        daysStale: r?.max_date
          ? Math.floor(
              (Date.now() - new Date(r.max_date).getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : -1,
      })
    } catch {
      summary.push({ table, rows: 0, minDate: 'ERR', maxDate: 'ERR', daysStale: -1 })
    }
  }

  console.table(summary)

  const stale = summary.filter((s) => s.daysStale > 3 && s.rows > 0)
  const empty = summary.filter((s) => s.rows === 0)

  if (stale.length > 0) {
    console.log(`\n⚠  STALE (>3 days): ${stale.map((s) => `${s.table} (${s.daysStale}d)`).join(', ')}`)
  }
  if (empty.length > 0) {
    console.log(`\n⚠  EMPTY: ${empty.map((s) => s.table).join(', ')}`)
  }
  if (stale.length === 0 && empty.length === 0) {
    console.log('\n✓ All tables fresh and populated.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
