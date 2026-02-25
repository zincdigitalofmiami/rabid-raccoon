import { prisma } from '@/lib/prisma'
import { toNum } from '@/lib/decimal'
import { refreshMes15mFromDatabento } from '@/lib/mes15m-refresh'
import type { Decimal } from '@prisma/client/runtime/client'

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
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume: bigint | null
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
        const initial = await prisma.mktFuturesMes15m.findMany({
          orderBy: { eventTime: 'desc' },
          take: backfillCount,
        })

        if (initial.length === 0) {
          pushErrorAndClose(
            'No MES 15m data in DB yet. Start ingestion: npm run ingest:mes:live:stream'
          )
          return
        }

        const sorted = [...initial].reverse().filter((r) => !isWeekendBar(r.eventTime))
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

      // Poll every 60 seconds and detect changed rows, including same-timestamp candle refreshes.
      const interval = setInterval(async () => {
        if (closed) return
        try {
          await refreshMes15mFromDatabento({ force: false })

          const latest = await prisma.mktFuturesMes15m.findMany({
            orderBy: { eventTime: 'desc' },
            take: Math.max(40, Math.min(250, backfillCount)),
          })

          if (latest.length === 0) {
            controller.enqueue(encodeSse('ping', { ts: Date.now() }))
            return
          }

          const sorted = [...latest].reverse().filter((r) => !isWeekendBar(r.eventTime))
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
