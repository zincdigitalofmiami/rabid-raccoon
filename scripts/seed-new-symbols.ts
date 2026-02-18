/**
 * seed-new-symbols.ts
 *
 * One-time: upserts NG, 6E, 6J, SR3 into the symbols master table
 * so the FK constraint on mkt_futures_1h.symbolCode is satisfied.
 *
 * Usage:
 *   npx tsx scripts/seed-new-symbols.ts
 */
import { prisma } from '../src/lib/prisma'
import { INGESTION_SYMBOLS } from '../src/lib/ingestion-symbols'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

const NEW_CODES = ['NG', '6E', '6J', 'SR3']

async function main() {
  for (const cfg of INGESTION_SYMBOLS.filter((s) => NEW_CODES.includes(s.code))) {
    await prisma.symbol.upsert({
      where: { code: cfg.code },
      create: {
        code: cfg.code,
        displayName: cfg.displayName,
        shortName: cfg.shortName,
        description: cfg.description,
        tickSize: cfg.tickSize,
        dataSource: 'DATABENTO',
        dataset: cfg.dataset,
        databentoSymbol: cfg.databentoSymbol,
      },
      update: {
        displayName: cfg.displayName,
        shortName: cfg.shortName,
        description: cfg.description,
        tickSize: cfg.tickSize,
        isActive: true,
      },
    })
    console.log(`[seed] upserted symbol: ${cfg.code} (${cfg.databentoSymbol})`)
  }
  console.log('[seed] done')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
