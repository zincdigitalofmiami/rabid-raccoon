import { NextResponse } from 'next/server'
import { loadAnalysisInputs } from '@/lib/analyse-data'
import { runInstantAnalysis } from '@/lib/instant-analysis'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  try {
    const { allData, symbolNames, marketContext } = await loadAnalysisInputs()
    const full = await runInstantAnalysis(allData, symbolNames, marketContext)

    return NextResponse.json({
      timestamp: full.timestamp,
      overallVerdict: full.overallVerdict,
      overallConfidence: full.overallConfidence,
      narrative: full.narrative,
      timeframeGauges: full.timeframeGauges,
      symbols: full.symbols,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    const isNoData = msg.includes('No market data available')
    return NextResponse.json(
      { error: `AI analysis failed: ${msg}` },
      { status: isNoData ? 503 : 500 }
    )
  }
}
