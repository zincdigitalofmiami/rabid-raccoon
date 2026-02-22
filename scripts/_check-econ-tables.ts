import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

// SECURITY: Allowlists for SQL identifiers used in $queryRawUnsafe calls.
// All values are constant-owned. Never accept user input for these.
const ALLOWED_TABLES = new Set([
  'econ_fx_1d', 'econ_rates_1d', 'econ_yields_1d', 'econ_vol_indices_1d',
  'econ_commodities_1d', 'econ_inflation_1d', 'econ_labor_1d', 'econ_money_1d',
  'news_signals',
])
const ALLOWED_COLUMNS = new Set([
  'seriesId', 'eventDate', 'layer', 'pubDate',
])

function assertAllowedId(value: string, allowlist: Set<string>, label: string) {
  if (!allowlist.has(value)) throw new Error(`Disallowed ${label}: "${value}"`)
}

async function main() {
  const tables = [
    'econ_fx_1d',
    'econ_rates_1d',
    'econ_yields_1d',
    'econ_vol_indices_1d',
    'econ_commodities_1d',
    'econ_inflation_1d',
    'econ_labor_1d',
    'econ_money_1d',
    'news_signals',
  ]

  for (const table of tables) {
    assertAllowedId(table, ALLOWED_TABLES, 'table')
    try {
      assertAllowedId('seriesId', ALLOWED_COLUMNS, 'column')
      assertAllowedId('eventDate', ALLOWED_COLUMNS, 'column')
      const rows = await prisma.$queryRawUnsafe<
        Array<{ seriesId: string; count: number; min_date: Date; max_date: Date }>
      >(`SELECT "seriesId", COUNT(*)::int as count, MIN("eventDate")::date as min_date, MAX("eventDate")::date as max_date FROM "${table}" GROUP BY "seriesId" ORDER BY "seriesId"`)

      console.log(`\n=== ${table} ===`)
      console.table(rows.map(r => ({
        series: r.seriesId,
        count: r.count,
        from: r.min_date?.toISOString().slice(0, 10) ?? 'N/A',
        to: r.max_date?.toISOString().slice(0, 10) ?? 'N/A',
      })))
    } catch (e: any) {
      // news_signals doesn't have seriesId — handle separately
      if (table === 'news_signals') {
        try {
          assertAllowedId(table, ALLOWED_TABLES, 'table')
          assertAllowedId('layer', ALLOWED_COLUMNS, 'column')
          assertAllowedId('pubDate', ALLOWED_COLUMNS, 'column')
          const rows = await prisma.$queryRawUnsafe<
            Array<{ layer: string; count: number; min_date: Date; max_date: Date }>
          >(`SELECT "layer", COUNT(*)::int as count, MIN("pubDate")::date as min_date, MAX("pubDate")::date as max_date FROM "${table}" GROUP BY "layer" ORDER BY "layer"`)
          console.log(`\n=== ${table} ===`)
          console.table(rows.map(r => ({
            layer: r.layer,
            count: r.count,
            from: r.min_date?.toISOString().slice(0, 10) ?? 'N/A',
            to: r.max_date?.toISOString().slice(0, 10) ?? 'N/A',
          })))
        } catch (e2: any) {
          console.log(`\n=== ${table} === ERROR: ${e2.message?.slice(0, 100)}`)
        }
      } else {
        console.log(`\n=== ${table} === ERROR: ${e.message?.slice(0, 100)}`)
      }
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
