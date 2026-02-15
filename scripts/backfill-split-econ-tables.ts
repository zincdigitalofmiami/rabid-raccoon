/**
 * backfill-split-econ-tables.ts
 *
 * One-time backfill: repopulates the 9 split econ domain tables from
 * the consolidated econ_observations_1d table. Uses INSERT...ON CONFLICT
 * DO NOTHING so it's safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-split-econ-tables.ts
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

interface DomainDef {
  category: string
  table: string
}

const DOMAINS: DomainDef[] = [
  { category: 'RATES', table: 'econ_rates_1d' },
  { category: 'YIELDS', table: 'econ_yields_1d' },
  { category: 'FX', table: 'econ_fx_1d' },
  { category: 'VOLATILITY', table: 'econ_vol_indices_1d' },
  { category: 'INFLATION', table: 'econ_inflation_1d' },
  { category: 'LABOR', table: 'econ_labor_1d' },
  { category: 'ACTIVITY', table: 'econ_activity_1d' },
  { category: 'MONEY', table: 'econ_money_1d' },
  { category: 'COMMODITIES', table: 'econ_commodities_1d' },
]

async function run(): Promise<void> {
  loadDotEnvFiles()
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  console.log('[backfill] Syncing split domain tables from econ_observations_1d...\n')

  for (const { category, table } of DOMAINS) {
    const result = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
      `INSERT INTO "${table}" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
       SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
       FROM "econ_observations_1d"
       WHERE "category" = '${category}'
       ON CONFLICT ("seriesId", "eventDate") DO NOTHING
       RETURNING 1`
    )
    const inserted = result?.length ?? 0
    console.log(`  ${table.padEnd(28)} +${inserted} rows (from ${category})`)
  }

  console.log('\n[backfill] Done.')
}

run()
  .catch((err) => {
    console.error(`[backfill] FATAL: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
