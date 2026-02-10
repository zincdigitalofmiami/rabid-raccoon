import { CandleData, DatabentoOhlcvRecord } from './types'

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const FIXED_PRICE_SCALE = 1_000_000_000

export async function fetchOhlcv(params: {
  dataset: string
  symbol: string
  stypeIn: string
  start: string
  end: string
  schema?: string
}): Promise<DatabentoOhlcvRecord[]> {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) {
    throw new Error('DATABENTO_API_KEY environment variable is not set')
  }

  const basicAuth = Buffer.from(`${apiKey}:`).toString('base64')

  const body = new URLSearchParams({
    dataset: params.dataset,
    symbols: params.symbol,
    schema: params.schema || 'ohlcv-1m',
    stype_in: params.stypeIn,
    start: params.start,
    end: params.end,
    encoding: 'json',
  })

  const response = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')

    // If end time is after available data, retry with a shorter range
    if (response.status === 422 && errorText.includes('data_end_after_available_end')) {
      try {
        const detail = JSON.parse(errorText)
        const availableEnd = detail?.detail?.payload?.available_end
        if (availableEnd) {
          // Retry with the available end time
          const retryBody = new URLSearchParams({
            dataset: params.dataset,
            symbols: params.symbol,
            schema: params.schema || 'ohlcv-1m',
            stype_in: params.stypeIn,
            start: params.start,
            end: availableEnd,
            encoding: 'json',
          })
          const retryResponse = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: retryBody.toString(),
          })
          if (retryResponse.ok) {
            const retryText = await retryResponse.text()
            return parseNdjson(retryText)
          }
        }
      } catch {
        // Fall through to error
      }
    }

    throw new Error(
      `Databento API error ${response.status}: ${response.statusText}. ${errorText.slice(0, 500)}`
    )
  }

  const text = await response.text()
  return parseNdjson(text)
}

function parseNdjson(text: string): DatabentoOhlcvRecord[] {
  if (!text.trim()) return []

  const records: DatabentoOhlcvRecord[] = []
  const lines = text.trim().split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as DatabentoOhlcvRecord)
    } catch {
      // Skip malformed lines
    }
  }
  return records
}

export function toCandles(records: DatabentoOhlcvRecord[]): CandleData[] {
  return records
    .map((r) => {
      // ts_event is nanoseconds since epoch (string)
      const tsNano = BigInt(r.hd.ts_event)
      const tsSec = Number(tsNano / 1_000_000_000n)

      // Prices come as strings or numbers from Databento JSON — handle both
      const open = Number(r.open) / FIXED_PRICE_SCALE
      const high = Number(r.high) / FIXED_PRICE_SCALE
      const low = Number(r.low) / FIXED_PRICE_SCALE
      const close = Number(r.close) / FIXED_PRICE_SCALE

      return {
        time: tsSec,
        open,
        high,
        low,
        close,
        volume: Number(r.volume),
      }
    })
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && !isNaN(c.open))
    .sort((a, b) => a.time - b.time)
}

/**
 * Get the start/end times for the current trading session.
 * Goes back 18 hours to capture the overnight Globex session.
 * Caps end time 30 minutes behind current time to avoid 422 errors
 * when Databento hasn't processed the most recent data yet.
 */
export function getCurrentSessionTimes(): { start: string; end: string } {
  const now = new Date()

  // Go back 18 hours for intraday + overnight view
  const start = new Date(now.getTime() - 18 * 60 * 60 * 1000)

  // Cap end time 30 minutes behind now (Databento has ~15-30 min delay for historical API)
  const end = new Date(now.getTime() - 30 * 60 * 1000)

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}
