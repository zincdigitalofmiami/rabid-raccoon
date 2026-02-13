import { CandleData, DatabentoOhlcvRecord } from './types'

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const FIXED_PRICE_SCALE = 1_000_000_000
const DATABENTO_REQUEST_TIMEOUT_MS = 90_000
const DATABENTO_MAX_ATTEMPTS = 4

export async function fetchOhlcv(params: {
  dataset: string
  symbol: string
  stypeIn: string
  start: string
  end: string
  schema?: string
  timeoutMs?: number
  maxAttempts?: number
}): Promise<DatabentoOhlcvRecord[]> {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) {
    throw new Error('DATABENTO_API_KEY environment variable is not set')
  }

  const basicAuth = Buffer.from(`${apiKey}:`).toString('base64')

  let queryEnd = params.end
  let lastErrorText = ''
  let lastStatus = 500
  let lastStatusText = 'Unknown'
  const requestTimeoutMs =
    Number.isFinite(params.timeoutMs) && (params.timeoutMs as number) > 0
      ? Math.max(5_000, Math.trunc(params.timeoutMs as number))
      : DATABENTO_REQUEST_TIMEOUT_MS
  const maxAttempts =
    Number.isFinite(params.maxAttempts) && (params.maxAttempts as number) > 0
      ? Math.max(1, Math.trunc(params.maxAttempts as number))
      : DATABENTO_MAX_ATTEMPTS

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const body = new URLSearchParams({
      dataset: params.dataset,
      symbols: params.symbol,
      schema: params.schema || 'ohlcv-1m',
      stype_in: params.stypeIn,
      start: params.start,
      end: queryEnd,
      encoding: 'json',
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timeout)
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('aborted')) {
        lastStatus = 408
        lastStatusText = 'Request Timeout'
        lastErrorText = `Databento request timed out after ${requestTimeoutMs}ms`
        continue
      }
      throw error
    }
    clearTimeout(timeout)

    if (response.ok) {
      const text = await response.text()
      return parseNdjson(text)
    }

    lastStatus = response.status
    lastStatusText = response.statusText
    lastErrorText = await response.text().catch(() => '')

    if (response.status !== 422) break

    let availableEnd: string | null = null
    try {
      const detail = JSON.parse(lastErrorText)
      availableEnd = detail?.detail?.payload?.available_end || null
    } catch {
      availableEnd = null
    }

    // Cannot recover 422 without a valid tighter end boundary.
    if (!availableEnd || availableEnd === queryEnd) break
    queryEnd = availableEnd
  }

  throw new Error(
    `Databento API error ${lastStatus}: ${lastStatusText}. ${lastErrorText.slice(0, 500)}`
  )
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
