import { prisma } from '../src/lib/prisma'
import { runIngestMacroIndicators } from './ingest-macro-indicators'
import { runIngestMarketBars } from './ingest-market-bars'
import { runIngestMeasuredMoveSignals } from './ingest-mm-signals'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()

  console.log('[ingest-all] step 1/3 market bars')
  const market = await runIngestMarketBars()
  console.log('[ingest-all] market bars complete')

  console.log('[ingest-all] step 2/3 macro indicators')
  const macro = await runIngestMacroIndicators()
  console.log('[ingest-all] macro indicators complete')

  console.log('[ingest-all] step 3/3 measured move signals')
  const mm = await runIngestMeasuredMoveSignals()
  console.log('[ingest-all] measured move signals complete')

  console.log(
    JSON.stringify(
      {
        market,
        macro,
        mm,
      },
      null,
      2
    )
  )
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ingest-all] failed: ${message}`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

