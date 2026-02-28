/**
 * backfill-split-econ-tables.ts
 *
 * Legacy helper kept for operator safety. Consolidated econ_observations_1d
 * has been retired; split domain tables are now the source of truth.
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()
  if (!process.env.LOCAL_DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL is required (or set PRISMA_DIRECT=1 with DIRECT_URL for explicit direct runs)')
  }

  const exists = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'econ_observations_1d'
    ) AS exists
  `

  if (exists[0]?.exists) {
    throw new Error('econ_observations_1d still exists. Run migrations before attempting any backfill workflow.')
  }

  console.log('[backfill] No action required. Split econ domain tables are canonical.')
}

run()
  .catch((err) => {
    console.error(`[backfill] FATAL: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
