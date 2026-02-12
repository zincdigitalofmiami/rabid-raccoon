import { NextResponse } from 'next/server'
import { loadAnalysisInputs } from '@/lib/analyse-data'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  try {
    const { marketContext } = await loadAnalysisInputs()
    return NextResponse.json(marketContext)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    const isNoData = msg.includes('No market data available')
    return NextResponse.json(
      { error: `Market analysis failed: ${msg}` },
      { status: isNoData ? 503 : 500 }
    )
  }
}
