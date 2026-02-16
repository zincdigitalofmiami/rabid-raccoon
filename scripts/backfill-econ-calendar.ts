/**
 * Backfill econ_calendar table with corrected FRED release IDs.
 * Runs each tier as a separate batch with pauses between.
 *
 * Usage:
 *   npx tsx scripts/backfill-econ-calendar.ts [--tier 1|2|3|rates|all]
 *
 * Default: --tier all (processes all tiers sequentially)
 */
import { loadDotEnvFiles } from './ingest-utils'
loadDotEnvFiles()

import { runIngestEconCalendar } from '../src/lib/ingest/econ-calendar'
import { prisma } from '../src/lib/prisma'

const BATCHES = [
  { name: 'Tier 1 (FOMC, NFP, CPI, PCE)', tier: '1', releaseIds: [101, 50, 10, 53] },
  { name: 'Tier 2 (PPI, Retail, GDP, Claims, JOLTS)', tier: '2', releaseIds: [46, 9, 21, 180, 192] },
  { name: 'Tier 3 (Sentiment, Durables, Housing, ADP, IndProd, Trade, Construction)', tier: '3', releaseIds: [54, 95, 27, 97, 194, 13, 51, 229] },
  { name: 'Interest Rates (daily H.15)', tier: 'rates', releaseIds: [18] },
]

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const tierArg = process.argv.find((a) => a.startsWith('--tier='))?.split('=')[1]
    || (process.argv.includes('--tier') ? process.argv[process.argv.indexOf('--tier') + 1] : 'all')

  const selected = tierArg === 'all'
    ? BATCHES
    : BATCHES.filter((b) => b.tier === tierArg)

  if (selected.length === 0) {
    console.error(`Unknown tier: ${tierArg}. Use 1, 2, 3, rates, or all.`)
    process.exit(1)
  }

  // Show current state
  const beforeCount = await prisma.econCalendar.count()
  console.log(`\nCurrent econ_calendar rows: ${beforeCount}\n`)

  for (const batch of selected) {
    console.log(`--- ${batch.name} ---`)
    console.log(`Release IDs: [${batch.releaseIds.join(', ')}]`)
    console.log('Starting...')

    const start = Date.now()
    const result = await runIngestEconCalendar({
      startDateStr: '2020-01-01',
      releaseIds: batch.releaseIds,
      includeEarnings: false,
      continueOnError: true,
    })

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`  Processed: ${result.processed}`)
    console.log(`  Inserted:  ${result.inserted}`)
    console.log(`  Updated:   ${result.updated}`)
    if (result.releaseErrors.length > 0) {
      console.log(`  Errors:    ${result.releaseErrors.length}`)
      for (const err of result.releaseErrors) {
        console.log(`    - Release ${err.releaseId} (${err.eventName}): ${err.error}`)
      }
    }
    console.log(`  Time:      ${elapsed}s`)
    console.log()

    // Pause 3 seconds between batches to stay well under FRED rate limits
    if (selected.indexOf(batch) < selected.length - 1) {
      console.log('Pausing 3s before next batch...\n')
      await sleep(3000)
    }
  }

  // Final counts
  const afterCount = await prisma.econCalendar.count()
  console.log(`\n=== Final econ_calendar rows: ${afterCount} (was ${beforeCount}) ===`)

  const byEvent = await prisma.econCalendar.groupBy({
    by: ['eventName'],
    _count: true,
    orderBy: { _count: { eventName: 'desc' } },
  })
  for (const row of byEvent) {
    console.log(`  ${row.eventName}: ${row._count}`)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
