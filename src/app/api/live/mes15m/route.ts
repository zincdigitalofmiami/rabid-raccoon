import { prisma } from '@/lib/prisma'

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

function encodeSse(event: string, payload: unknown): Uint8Array {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  return new TextEncoder().encode(body)
}

function asPoint(row: {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}): MesPricePoint {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const backfill = Number(url.searchParams.get('backfill') || '96')
  const backfillCount = Number.isFinite(backfill)
    ? Math.max(20, Math.min(500, Math.trunc(backfill)))
    : 96

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let lastEventTime: Date | null = null

      const pushErrorAndClose = (message: string) => {
        if (closed) return
        controller.enqueue(encodeSse('error', { error: message }))
        controller.close()
        closed = true
      }

      try {
        const initial = await prisma.mesPrice15m.findMany({
          orderBy: { eventTime: 'desc' },
          take: backfillCount,
        })

        if (initial.length === 0) {
          pushErrorAndClose(
            'No MES 15m data in DB yet. Start ingestion: npm run ingest:mes:live:stream'
          )
          return
        }

        const sorted = [...initial].reverse()
        lastEventTime = sorted[sorted.length - 1].eventTime

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

      // Poll every 15 seconds (15m candles don't need sub-second updates)
      const interval = setInterval(async () => {
        if (closed || !lastEventTime) return
        try {
          const updates = await prisma.mesPrice15m.findMany({
            where: {
              eventTime: { gt: lastEventTime },
            },
            orderBy: { eventTime: 'asc' },
            take: 100,
          })

          if (updates.length === 0) {
            controller.enqueue(encodeSse('ping', { ts: Date.now() }))
            return
          }

          lastEventTime = updates[updates.length - 1].eventTime
          controller.enqueue(
            encodeSse('update', {
              points: updates.map(asPoint),
            })
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          pushErrorAndClose(`Live stream query failed: ${message}`)
        }
      }, 15_000)

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
