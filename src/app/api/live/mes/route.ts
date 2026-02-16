import { prisma } from '@/lib/prisma'
import { toNum } from '@/lib/decimal'
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
  const backfill = Number(url.searchParams.get('backfill') || '160')
  const backfillCount = Number.isFinite(backfill)
    ? Math.max(40, Math.min(1200, Math.trunc(backfill)))
    : 160

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
        const initial = await prisma.mktFuturesMes15m.findMany({
          orderBy: { eventTime: 'desc' },
          take: backfillCount,
        })

        if (initial.length === 0) {
          pushErrorAndClose(
            'No MES 15m data in DB yet. Start local live ingestion: npm run ingest:mes:live -- --once=true'
          )
          return
        }

        const sorted = [...initial].reverse()
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
        pushErrorAndClose(`Failed to load MES live snapshot: ${message}`)
        return
      }

      const interval = setInterval(async () => {
        if (closed) return
        try {
          const latest = await prisma.mktFuturesMes15m.findMany({
            orderBy: { eventTime: 'desc' },
            take: Math.max(80, Math.min(400, backfillCount)),
          })

          if (latest.length === 0) {
            controller.enqueue(encodeSse('ping', { ts: Date.now() }))
            return
          }

          const sorted = [...latest].reverse()
          const changed = sorted.filter((row) => {
            const key = row.eventTime.getTime()
            const next = rowFingerprint(row)
            const prev = knownRows.get(key)
            if (prev === next) return false
            knownRows.set(key, next)
            return true
          })

          const keep = new Set(sorted.map((r) => r.eventTime.getTime()))
          if (knownRows.size > 800) {
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
      }, 2000)

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
