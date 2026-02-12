import { prisma } from '../src/lib/prisma'
import { runIngestAltNewsFeeds } from './ingest-alt-news-feeds'
import { runIngestMacroIndicators } from './ingest-macro-indicators'
import { runIngestMarketPrices } from './ingest-market-prices'
import { runIngestMeasuredMoveSignals } from './ingest-mm-signals'
import { loadDotEnvFiles } from './ingest-utils'

async function run(): Promise<void> {
  loadDotEnvFiles()

  console.log('[ingest-all] step 1/3 market prices')
  const market = await runIngestMarketPrices()
  console.log('[ingest-all] market prices complete')

  console.log('[ingest-all] step 2/4 macro indicators')
  const macro = await runIngestMacroIndicators()
  console.log('[ingest-all] macro indicators complete')

  console.log('[ingest-all] step 3/4 alt news')
  const altNews = await runIngestAltNewsFeeds()
  console.log('[ingest-all] alt news complete')

  console.log('[ingest-all] step 4/4 measured move signals')
  const mm = await runIngestMeasuredMoveSignals({ timeframe: '1h', symbols: ['MES'] })
  console.log('[ingest-all] measured move signals complete')

  console.log(
    JSON.stringify(
      {
        market,
        macro,
        altNews,
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
