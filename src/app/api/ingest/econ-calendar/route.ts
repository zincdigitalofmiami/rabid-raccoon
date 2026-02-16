import { NextResponse } from 'next/server'
import { runIngestEconCalendar } from '@/lib/ingest/econ-calendar'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const startDateStr = url.searchParams.get('start') || '2020-01-01'
    const result = await runIngestEconCalendar(startDateStr)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
