import { toNum } from '@/lib/decimal'
import { readLatestMes1mRows, readLatestMes15mRows } from '@/lib/mes-live-queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface MesPricePoint {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

interface MesRow {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

interface Mes1mRow {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

function encodeSse(event: string, payload: unknown): Uint8Array {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  return new TextEncoder().encode(body)
}

function asPoint(row: MesRow): MesPricePoint {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

/**
 * CME Globex MES session: Sunday 5 PM CT → Friday 4 PM CT.
 * Bars outside this window are closed-market artifacts — filter them out.
 *
 * CT offsets: CST = UTC-6 (Nov–Mar), CDT = UTC-5 (Mar–Nov).
 * We use conservative UTC boundaries that work for both DST states.
 */
function isWeekendBar(date: Date): boolean {
  const day = date.getUTCDay()   // 0=Sun, 6=Sat
  const hour = date.getUTCHours()

  // Saturday: always closed
  if (day === 6) return true

  // Sunday before 22:00 UTC (covers CDT open at 22:00 and CST open at 23:00)
  if (day === 0 && hour < 22) return true

  // Friday after 22:00 UTC (covers CST close at 22:00 and CDT close at 21:00)
  if (day === 5 && hour >= 22) return true

  return false
}

function rowFingerprint(row: MesRow): string {
  return [
    row.eventTime.getTime(),
    toNum(row.open),
    toNum(row.high),
    toNum(row.low),
    toNum(row.close),
    row.volume == null ? 0 : Number(row.volume),
  ].join('|')
}

const FIFTEEN_MIN_SECONDS = 15 * 60

function sanitize1mRows(rows: Mes1mRow[]): Mes1mRow[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort(
    (a, b) => a.eventTime.getTime() - b.eventTime.getTime()
  )
  const clean: Mes1mRow[] = []
  let prevClose: number | null = null

  for (const row of sorted) {
    const o = toNum(row.open)
    const h = toNum(row.high)
    const l = toNum(row.low)
    const c = toNum(row.close)

    // Base OHLC sanity
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
    if (h < l) continue
    // 1m range sanity: reject pathological ticks
    if ((h - l) / Math.max(o, 1) > 0.08) continue

    if (prevClose != null && prevClose > 0) {
      // continuity sanity against prior clean close
      if (Math.abs(o - prevClose) / prevClose > 0.08) continue
      if (Math.abs(c - prevClose) / prevClose > 0.08) continue
      if (h > prevClose * 1.12) continue
      if (l < prevClose * 0.88) continue
    }

    clean.push(row)
    prevClose = c
  }

  return clean
}

function aggregateTo15mFrom1m(rows: Mes1mRow[]): MesRow[] {
  if (rows.length === 0) return []
  const sorted = sanitize1mRows(rows)
  if (sorted.length === 0) return []
  const out: MesRow[] = []

  let bucketStartSec = -1
  let bucket: MesRow | null = null

  for (const row of sorted) {
    const sec = Math.floor(row.eventTime.getTime() / 1000)
    const alignedSec = Math.floor(sec / FIFTEEN_MIN_SECONDS) * FIFTEEN_MIN_SECONDS
    const alignedTime = new Date(alignedSec * 1000)

    if (!bucket || alignedSec !== bucketStartSec) {
      if (bucket) out.push(bucket)
      bucketStartSec = alignedSec
      bucket = {
        eventTime: alignedTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }
      continue
    }

    bucket.high = Math.max(toNum(bucket.high), toNum(row.high))
    bucket.low = Math.min(toNum(bucket.low), toNum(row.low))
    bucket.close = row.close
    const prevVol = bucket.volume == null ? 0 : bucket.volume
    const nextVol = row.volume == null ? 0 : row.volume
    bucket.volume = prevVol + nextVol
  }

  if (bucket) out.push(bucket)
  return out
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const backfill = Number(url.searchParams.get('backfill') || '96')
  const backfillCount = Number.isFinite(backfill)
    ? Math.max(20, Math.min(1000, Math.trunc(backfill)))
    : 96

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const knownRows = new Map<number, string>()

      const pushErrorAndClose = (message: string) => {
        if (closed) return
        controller.enqueue(encodeSse('error', { error: message }))
        controller.close()
        closed = true
      }

      try {
        // Serve DB data immediately — don't block on Databento refresh
        // Background refresh runs on first poll interval (60s)
        const oneMinuteBackfill = Math.max(backfillCount * 15 + 240, 2400)
        const initial1m = await readLatestMes1mRows(oneMinuteBackfill)

        const aggregated15m = aggregateTo15mFrom1m(initial1m).slice(-backfillCount)
        const fallback15m = aggregated15m.length === 0
          ? await readLatestMes15mRows(backfillCount)
          : []
        const initial = aggregated15m.length > 0 ? aggregated15m : fallback15m

        if (initial.length === 0) {
          pushErrorAndClose(
            'No MES 15m data in DB yet. Start ingestion: npm run ingest:mes:live:stream'
          )
          return
        }

        const sorted = [...initial]
          .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
          .filter((r) => !isWeekendBar(r.eventTime))
        for (const row of sorted) {
          knownRows.set(row.eventTime.getTime(), rowFingerprint(row))
        }

        controller.enqueue(
          encodeSse('snapshot', {
            points: sorted.map(asPoint),
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pushErrorAndClose(`Failed to load MES 15m snapshot: ${message}`)
        return
      }

      // Poll every 60 seconds and detect changed rows from Inngest-managed ingestion.
      const interval = setInterval(async () => {
        if (closed) return
        try {
          const oneMinuteLookback = Math.max(
            4000,
            Math.max(40, Math.min(250, backfillCount)) * 15 + 240
          )
          const latest1m = await readLatestMes1mRows(oneMinuteLookback)
          const latest = aggregateTo15mFrom1m(latest1m).slice(
            -Math.max(40, Math.min(250, backfillCount))
          )

          if (latest.length === 0) {
            controller.enqueue(encodeSse('ping', { ts: Date.now() }))
            return
          }

          const sorted = [...latest]
            .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
            .filter((r) => !isWeekendBar(r.eventTime))
          const changed = sorted.filter((row) => {
            const key = row.eventTime.getTime()
            const next = rowFingerprint(row)
            const prev = knownRows.get(key)
            if (prev === next) return false
            knownRows.set(key, next)
            return true
          })

          // Keep map bounded to recent rows only.
          const keep = new Set(sorted.map((r) => r.eventTime.getTime()))
          if (knownRows.size > 400) {
            for (const key of knownRows.keys()) {
              if (!keep.has(key)) knownRows.delete(key)
            }
          }

          if (changed.length === 0) {
            controller.enqueue(encodeSse('ping', { ts: Date.now() }))
            return
          }

          controller.enqueue(
            encodeSse('update', {
              points: changed.map(asPoint),
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          pushErrorAndClose(`Live stream query failed: ${message}`)
        }
      }, 60_000)

      const abortListener = () => {
        if (closed) return
        clearInterval(interval)
        controller.close()
        closed = true
      }

      request.signal.addEventListener('abort', abortListener)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
