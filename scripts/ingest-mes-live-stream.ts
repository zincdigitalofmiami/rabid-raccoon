/**
 * Databento Live MES 15m Streaming Ingestion
 *
 * Polls Databento Historical API for 1m bars, aggregates into 15m candles,
 * and upserts into mesPrice15m table.
 *
 * NOTE: Databento's Live API uses a custom binary TCP protocol (DBN) with no
 * Node.js SDK available. This script uses the REST historical API as a bridge.
 * When a Node.js Live SDK ships, swap the data source without changing the
 * aggregation or DB layer.
 *
 * Usage:
 *   npm run ingest:mes:live:stream
 *   npm run ingest:mes:live:stream -- --once=true --lookback-minutes=720
 */

import { runMesLiveIngestion15m } from './ingest-mes-live-15m'

// Delegate to existing 15m ingestion loop
runMesLiveIngestion15m()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[mes-live-stream] failed: ${message}`)
    process.exit(1)
  })
