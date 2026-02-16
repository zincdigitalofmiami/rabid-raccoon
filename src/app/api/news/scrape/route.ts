import { NextResponse } from 'next/server'
import { runNewsScrape } from '@/lib/news-scrape'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const layer = url.searchParams.get('layer') || undefined
    const result = await runNewsScrape(layer)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
